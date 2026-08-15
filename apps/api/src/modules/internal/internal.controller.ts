/**
 * Internal endpoints — called by the worker, never by a user.
 *
 * ## Why these exist rather than the worker doing the work itself
 *
 * The organising principle of this stack is that there is exactly ONE copy of the
 * billing maths and one copy of the domain rules. A worker holding its own copy of GST
 * thresholds, late-fee accrual or the approval ladder would drift from the API's copy,
 * and the drift would be silent — the resident sees one number, the ledger records
 * another, and nobody notices until a month-end close.
 *
 * So the worker schedules and fans out; the API decides. These are the seams between
 * them.
 *
 * ## Authentication
 *
 * A shared service token, not a user session. There is no person behind these calls, so
 * a JWT with a personId would be a fiction. The token is checked in TenantMiddleware
 * before any of this is reached, and `societyId` arrives in the body because the worker
 * is explicitly acting across tenants.
 *
 * Every handler is idempotent. Cloud Tasks and Cloud Scheduler both retry, and a retry
 * must not produce a second invoice or a second escalation.
 */

import { Body, Controller, Post } from "@nestjs/common";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { schema, withoutTenant, withSystemTenant } from "@watchmygate/db";

import { runWithContext } from "../../common/tenant-context.js";
import { BillingService } from "../billing/billing.service.js";
import { ApprovalService } from "../gate/approval.service.js";
import { HelpdeskService } from "../helpdesk/helpdesk.service.js";
import { LedgerService } from "../ledger/ledger.service.js";

const societyBody = z.object({ societyId: z.string().uuid() });

const advanceBody = z.object({
  societyId: z.string().uuid(),
  approvalId: z.string().uuid(),
});

const billingRunBody = z.object({
  societyId: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  dueDate: z.string(),
  /** Preview only — used to check a run before committing invoices to the ledger. */
  dryRun: z.boolean().optional(),
});

/**
 * The worker has no person identity, so handlers run under a synthetic context.
 *
 * `personId` is the zero UUID rather than a real user: audit rows written by background
 * work must be distinguishable from work a human did. Attributing an automated
 * escalation to whichever admin happened to be around would corrupt the audit trail.
 */
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

function asSystem<T>(societyId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      societyId,
      personId: SYSTEM_ACTOR,
      roles: ["system"],
      requestId: `worker-${Date.now()}`,
    },
    fn,
  );
}

@Controller("internal")
export class InternalController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly billing: BillingService,
    private readonly helpdesk: HelpdeskService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Every society the worker should sweep.
   *
   * Genuinely cross-tenant, and safe: it returns only ids and names, never any
   * society's data. The worker uses it to fan out one scoped call per society.
   */
  @Post("societies")
  async societies() {
    const rows = await withoutTenant("worker_society_fanout", async (db) =>
      db
        .select({ id: schema.societies.id, name: schema.societies.name })
        .from(schema.societies)
        .where(eq(schema.societies.status, "active")),
    );
    return { societies: rows };
  }

  /**
   * Advance one approval to its next due rung.
   *
   * Idempotent by construction: the ladder is driven by elapsed time and the set of
   * rungs already fired, so a duplicate Cloud Task delivery finds nothing due and does
   * nothing. See ladder.ts.
   */
  @Post("approvals/advance")
  async advanceApproval(@Body() body: unknown) {
    const { societyId, approvalId } = advanceBody.parse(body);
    return asSystem(societyId, () => this.approvals.advance(approvalId));
  }

  /**
   * Monthly billing run for one society.
   *
   * Invoices are issued one unit at a time in separate transactions. A society with 400
   * flats must not lose 399 good invoices because the 400th has a missing meter reading
   * — that unit is reported and the run continues, which is also what lets the run be
   * re-tried safely after the data is fixed.
   *
   * Re-running is safe: `issue` rejects a second invoice for the same unit and period,
   * so a retry produces `already_billed` rather than a duplicate charge.
   */
  @Post("billing/run")
  async billingRun(@Body() body: unknown) {
    const input = billingRunBody.parse(body);

    return asSystem(input.societyId, async () => {
      const units = await withSystemTenant(
        input.societyId,
        "billing_run_unit_list",
        async (db) =>
          db
            .select({ id: schema.units.id, number: schema.units.number })
            .from(schema.units)
            .where(eq(schema.units.status, "occupied")),
      );

      const issued: string[] = [];
      const alreadyBilled: string[] = [];
      const failed: Array<{ unit: string; reason: string }> = [];

      for (const unit of units) {
        const args = {
          unitId: unit.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dueDate: input.dueDate,
        };
        try {
          if (input.dryRun) {
            await this.billing.preview(args);
            issued.push(unit.number);
          } else {
            const invoice = await this.billing.issue(args);
            issued.push(invoice.invoiceNumber);
          }
        } catch (error) {
          const message = (error as Error).message;
          // A conflict means this unit already has an invoice for the period, which is
          // the expected outcome of a retry rather than a failure to report.
          if (/already been billed/i.test(message)) {
            alreadyBilled.push(unit.number);
          } else {
            failed.push({ unit: unit.number, reason: message });
          }
        }
      }

      return {
        societyId: input.societyId,
        dryRun: Boolean(input.dryRun),
        units: units.length,
        issued: issued.length,
        alreadyBilled: alreadyBilled.length,
        failed,
      };
    });
  }

  /**
   * Escalate complaints past their deadline.
   *
   * `escalatedAt` is set when a ticket escalates and is checked before escalating, so a
   * ticket escalates once no matter how often the sweep runs.
   */
  @Post("helpdesk/sla-sweep")
  async slaSweep(@Body() body: unknown) {
    const { societyId } = societyBody.parse(body);

    return asSystem(societyId, async () =>
      withSystemTenant(societyId, "sla_sweep", async (db) => {
        const now = new Date();
        const overdue = await this.helpdesk.dueForEscalation(db, societyId, now);

        for (const ticket of overdue) {
          await db
            .update(schema.tickets)
            .set({ escalatedAt: now, priority: "high", updatedAt: now })
            .where(eq(schema.tickets.id, ticket.id));

          await db.insert(schema.ticketEvents).values({
            societyId,
            ticketId: ticket.id,
            actorId: null,
            type: "escalation",
            body:
              `Escalated automatically: unresolved past the ${ticket.ticketNumber} ` +
              `service deadline.`,
            visibility: "public",
          });
        }

        return { societyId, escalated: overdue.length };
      }),
    );
  }

  /**
   * Verify the ledger still balances.
   *
   * Runs nightly. Any violation is a paging-level event: it means money has been
   * recorded that does not add up, and every hour it goes unnoticed is another hour of
   * entries built on top of it.
   */
  @Post("ledger/invariants")
  async invariants(@Body() body: unknown) {
    const { societyId } = societyBody.parse(body);
    const violations = await asSystem(societyId, () => this.ledger.checkInvariants());
    return { societyId, ok: violations.length === 0, violations };
  }

  /**
   * Flag visitors who entered and never left.
   *
   * Uses `server_ts`, never the guard handset's clock — device clocks are routinely
   * hours out, which would either alert constantly or never.
   *
   * `overstayAlertedAt` makes it fire once per visit rather than every sweep.
   */
  @Post("gate/overstay-sweep")
  async overstaySweep(@Body() body: unknown) {
    const parsed = z
      .object({ societyId: z.string().uuid(), hours: z.number().int().min(1).max(72).optional() })
      .parse(body);
    const hours = parsed.hours ?? 12;

    return asSystem(parsed.societyId, () =>
      withSystemTenant(parsed.societyId, "overstay_sweep", async (db) => {
        const cutoff = new Date(Date.now() - hours * 3600_000);

        const stale = await db
          .select({ id: schema.gateEvents.id })
          .from(schema.gateEvents)
          .where(
            and(
              eq(schema.gateEvents.direction, "entry"),
              lt(schema.gateEvents.serverTs, cutoff),
              isNull(schema.gateEvents.overstayAlertedAt),
              sql`NOT EXISTS (
                SELECT 1 FROM gate_events x WHERE x.exit_of_event_id = ${schema.gateEvents.id}
              )`,
            ),
          )
          .limit(500);

        for (const event of stale) {
          await db
            .update(schema.gateEvents)
            .set({ overstayAlertedAt: new Date() })
            .where(eq(schema.gateEvents.id, event.id));
        }

        return { societyId: parsed.societyId, flagged: stale.length, thresholdHours: hours };
      }),
    );
  }

  /**
   * Create next month's `audit_log` partition ahead of time.
   *
   * Migration 0001 seeds a rolling window, but a window eventually runs out — and the
   * failure mode is that every audited action starts erroring at midnight on the 1st,
   * which is a spectacularly bad time to discover it. Runs monthly, creates several
   * months ahead, and is safe to run repeatedly.
   */
  @Post("maintenance/audit-partitions")
  async auditPartitions() {
    // Goes through the SECURITY DEFINER function from migration 0006. The application
    // role holds USAGE but not CREATE on schema public, so it cannot make a table —
    // deliberately, since a role that can create objects is one injection away from
    // installing a trigger. Inlining the DDL here returned "permission denied for
    // schema public", and the permission was the part that was right.
    const result = await withoutTenant("audit_partition_maintenance", async (db) =>
      db.execute<{ partition_name: string; created: boolean }>(
        sql`SELECT * FROM ensure_audit_partitions(3)`,
      ),
    );

    const created = result.rows.filter((r) => r.created).map((r) => r.partition_name);

    return {
      status: "ok",
      checked: result.rows.length,
      created,
      partitions: result.rows.map((r) => r.partition_name),
    };
  }
}
