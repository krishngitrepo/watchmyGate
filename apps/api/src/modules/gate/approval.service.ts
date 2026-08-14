/**
 * Visitor approval — the ladder, in the database.
 *
 * Timing rules live in `ladder.ts` as pure functions; this module is the part that
 * talks to Postgres and the notification channels. Keeping them apart is what lets the
 * 90-second escalation be tested in a millisecond.
 *
 * The one rule that overrides everything else here: **AI never auto-denies a person
 * entry, and neither does a timeout.** A standing rule can deny because a human wrote
 * it. Silence cannot — silence escalates to a human. Getting this backwards would mean
 * a delivery worker turned away because a resident was in a meeting.
 */

import { Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { NotFoundError, ValidationError } from "../../common/errors.js";
import { TasksService } from "../../common/tasks.service.js";
import { currentContext, tx } from "../../common/tenant-context.js";
import { SmsService } from "../notify/sms.service.js";
import {
  LADDER,
  matchStandingRule,
  nextRung,
  outcomeOfStandingRule,
  secondsUntilNextRung,
  type Rung,
  type StandingRule,
  type VisitorCategory,
} from "./ladder.js";

export interface ApprovalRequest {
  unitId: string;
  category: VisitorCategory;
  visitorName?: string | undefined;
  visitorPhone?: string | undefined;
  photoKey?: string | undefined;
  gateEventId?: string | undefined;
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly tasks: TasksService,
    private readonly sms: SmsService,
  ) {}

  /**
   * A guard has someone at the gate. Start the ladder.
   *
   * Returns as soon as the row is written — the SLO is that our acknowledgement is
   * under 800 ms, so nothing that can wait until after the response happens before it.
   * The push is fired and the remaining rungs are scheduled after the row exists.
   */
  async request(input: ApprovalRequest): Promise<{
    approvalId: string;
    state: string;
    ladder: typeof LADDER;
  }> {
    const { societyId } = currentContext();
    const requestedAt = new Date();

    const approvalId = await tx(async (db) => {
      const [row] = await db
        .insert(schema.approvals)
        .values({
          societyId,
          unitId: input.unitId,
          gateEventId: input.gateEventId ?? null,
          state: "pending",
          requestedAt,
          visitorName: input.visitorName ?? null,
          visitorPhone: input.visitorPhone ?? null,
          category: input.category,
          photoKey: input.photoKey ?? null,
        })
        .returning({ id: schema.approvals.id });
      return row!.id;
    });

    await this.fireRung(approvalId, "push");
    await this.scheduleNext(approvalId);

    return { approvalId, state: "pending", ladder: LADDER };
  }

  /**
   * Advance the ladder. Called by the worker when a scheduled rung comes due.
   *
   * Safe to call late, twice, or out of order:
   *   - already resolved  → nothing happens
   *   - rung already fired → `nextRung` skips it
   *   - called hours late  → the earliest *unfired* rung is what runs, so a resident
   *     still gets their push even if the whole system was down
   *
   * That is why the ladder is driven by elapsed time rather than a chain of timers.
   */
  async advance(approvalId: string): Promise<{ state: string; fired: Rung | null }> {
    const approval = await this.get(approvalId);

    if (approval.state !== "pending") {
      return { state: approval.state, fired: null };
    }

    const fired = await this.firedRungs(approvalId);
    const elapsed = (Date.now() - approval.requestedAt.getTime()) / 1000;
    const due = nextRung(fired, elapsed);

    if (!due) {
      await this.scheduleNext(approvalId);
      return { state: approval.state, fired: null };
    }

    if (due === "standing_rule") {
      const state = await this.applyStandingRule(approvalId, approval);
      if (state) return { state, fired: due };
    } else if (due === "mc_escalation") {
      await this.fireRung(approvalId, due);
      await this.markEscalated(approvalId);
      return { state: "escalated", fired: due };
    } else {
      await this.fireRung(approvalId, due);
    }

    await this.scheduleNext(approvalId);
    return { state: "pending", fired: due };
  }

  /**
   * A resident tapped approve or deny.
   *
   * First response wins. A second tap — from the other parent, on the other handset —
   * gets a clear "already decided" rather than silently overwriting the first decision.
   */
  async resolve(
    approvalId: string,
    decision: "approved" | "denied",
  ): Promise<{ state: string }> {
    const { personId } = currentContext();

    const updated = await tx(async (db) => {
      const rows = await db
        .update(schema.approvals)
        .set({
          state: decision,
          resolvedAt: new Date(),
          resolvedBy: personId,
          resolutionRung: "push",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.approvals.id, approvalId),
            // The guard against a double decision, in the WHERE rather than in a
            // read-then-write that two handsets could interleave.
            eq(schema.approvals.state, "pending"),
          ),
        )
        .returning({ id: schema.approvals.id });
      return rows.length > 0;
    });

    if (!updated) {
      const current = await this.get(approvalId);
      throw new ValidationError(
        `This visitor was already ${current.state.replace("_", " ")}.`,
      );
    }

    return { state: decision };
  }

  /**
   * The 45-second rung: apply whatever the resident decided in advance.
   *
   * `ask_to_wait` deliberately does not resolve — it means "I have not decided", so the
   * ladder continues to committee escalation. Treating indecision as refusal would have
   * a resident silently turn away their own guest.
   */
  private async applyStandingRule(
    approvalId: string,
    approval: { unitId: string; category: string; visitorName: string | null },
  ): Promise<string | null> {
    const rules = await this.standingRulesFor(approval.unitId);
    const matched = matchStandingRule(rules, {
      category: approval.category as VisitorCategory,
      visitorName: approval.visitorName,
    });

    await this.fireRung(
      approvalId,
      "standing_rule",
      matched ? `matched rule ${matched.id} → ${matched.action}` : "no standing rule",
    );

    if (!matched) return null;

    const outcome = outcomeOfStandingRule(matched.action);
    if (!outcome.resolved) return null;

    await tx(async (db) => {
      await db
        .update(schema.approvals)
        .set({
          state: outcome.state,
          resolvedAt: new Date(),
          resolutionRung: "standing_rule",
          standingRuleId: matched.id,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.approvals.id, approvalId), eq(schema.approvals.state, "pending")),
        );
    });

    return outcome.state;
  }

  private async markEscalated(approvalId: string): Promise<void> {
    await tx(async (db) => {
      await db
        .update(schema.approvals)
        .set({ state: "escalated", updatedAt: new Date() })
        .where(
          and(eq(schema.approvals.id, approvalId), eq(schema.approvals.state, "pending")),
        );
    });
  }

  /** Record that a rung fired, and actually deliver it. */
  private async fireRung(
    approvalId: string,
    rung: Rung,
    result?: string,
  ): Promise<void> {
    const { societyId } = currentContext();

    await tx(async (db) => {
      await db.insert(schema.approvalRungs).values({
        societyId,
        approvalId,
        rung,
        firedAt: new Date(),
        channelResult: result ?? null,
      });
    });

    await this.deliver(approvalId, rung);
  }

  /**
   * Send the notification for a rung.
   *
   * Every channel is stubbed until credentials arrive, and stub mode logs rather than
   * calls. The ladder logic is therefore fully exercisable now — only the delivery is
   * pending, and it is pending visibly.
   */
  private async deliver(approvalId: string, rung: Rung): Promise<void> {
    switch (rung) {
      case "push":
        // FCM fan-out to every device on the unit. High priority: a normal-priority
        // push can be held by Doze for minutes, which would make the 20 s rung
        // meaningless on exactly the cheap handsets our residents use.
        this.log("push", { approvalId, priority: "high" });
        break;

      case "ivr": {
        // The phone ringing is what actually gets attention. SMS accompanies it because
        // an unanswered call leaves nothing behind to act on.
        this.log("ivr", { approvalId, provider: "exotel" });
        const approval = await this.get(approvalId);
        if (approval.visitorPhone) {
          this.log("sms", { approvalId, to: "primary resident" });
        }
        break;
      }

      case "sms":
        this.log("sms", { approvalId });
        break;

      case "standing_rule":
        break; // No notification — this rung decides rather than asks.

      case "mc_escalation":
        this.log("mc_escalation", { approvalId });
        break;
    }
  }

  private log(channel: string, detail: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.info(JSON.stringify({ event: "approval_rung_delivered", channel, ...detail }));
  }

  /** Queue the next rung for the moment it becomes due. */
  private async scheduleNext(approvalId: string): Promise<void> {
    const fired = await this.firedRungs(approvalId);
    const at = secondsUntilNextRung(fired);
    if (at === null) return;

    const approval = await this.get(approvalId);
    const elapsed = (Date.now() - approval.requestedAt.getTime()) / 1000;
    const delay = Math.max(0, at - elapsed);

    await this.tasks.schedule({
      path: "/tasks/approval-rung",
      payload: { approvalId, societyId: currentContext().societyId },
      delaySeconds: delay,
      // One task per approval per rung: a retried request cannot double-schedule.
      dedupeName: `approval-${approvalId}-${fired.length}`,
    });
  }

  private async firedRungs(approvalId: string): Promise<Rung[]> {
    return tx(async (db) => {
      const rows = await db
        .select({ rung: schema.approvalRungs.rung })
        .from(schema.approvalRungs)
        .where(eq(schema.approvalRungs.approvalId, approvalId));
      return rows.map((r) => r.rung as Rung);
    });
  }

  private async standingRulesFor(unitId: string): Promise<StandingRule[]> {
    return tx(async (db) => {
      const rows = await db
        .select()
        .from(schema.standingRules)
        .where(
          and(
            eq(schema.standingRules.unitId, unitId),
            eq(schema.standingRules.isActive, true),
          ),
        );
      return rows.map((r) => ({
        id: r.id,
        category: r.category as VisitorCategory | null,
        matcher: r.matcher,
        action: r.action,
        isActive: r.isActive,
      }));
    });
  }

  async get(approvalId: string) {
    return tx(async (db) => {
      const [row] = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, approvalId))
        .limit(1);
      if (!row) throw new NotFoundError("Approval request not found.");
      return row;
    });
  }

  /** Full ladder history — what fired, when, and what happened. */
  async history(approvalId: string) {
    await this.get(approvalId); // 404s across societies
    return tx(async (db) =>
      db
        .select()
        .from(schema.approvalRungs)
        .where(eq(schema.approvalRungs.approvalId, approvalId))
        .orderBy(schema.approvalRungs.firedAt),
    );
  }

  /** Everything still waiting, for the guard's screen. */
  async pending() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.state, "pending"))
        .orderBy(desc(schema.approvals.requestedAt))
        .limit(100),
    );
  }
}
