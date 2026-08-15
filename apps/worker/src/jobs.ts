/**
 * The jobs themselves.
 *
 * Each is a thin orchestration over the API's `/internal/*` endpoints: fan out across
 * societies, call the API once per society, collect results. Deliberately no domain
 * logic here — see internal.controller.ts for why there is exactly one copy of it.
 *
 * Every job is safe to run twice. Cloud Scheduler guarantees *at-least-once*, not
 * exactly-once, and a retried billing run that issued a second invoice would be a
 * genuine financial incident.
 */

import { callApi } from "./api-client.js";

export interface JobResult {
  job: string;
  societies: number;
  ok: number;
  failed: Array<{ societyId: string; error: string }>;
  detail: unknown[];
  durationMs: number;
}

/**
 * Run one operation for every active society.
 *
 * One society's failure must not stop the rest. A society with a broken chart of
 * accounts should not prevent the other 999 from being billed — it should be reported
 * and skipped, which is also what makes the retry useful rather than repeatedly fatal.
 */
async function forEachSociety(
  job: string,
  operation: (societyId: string) => Promise<unknown>,
): Promise<JobResult> {
  const started = Date.now();
  const { societies } = await callApi<{ societies: Array<{ id: string; name: string }> }>(
    "/internal/societies",
    {},
  );

  const detail: unknown[] = [];
  const failed: Array<{ societyId: string; error: string }> = [];

  for (const society of societies) {
    try {
      detail.push(await operation(society.id));
    } catch (error) {
      failed.push({ societyId: society.id, error: (error as Error).message });
    }
  }

  return {
    job,
    societies: societies.length,
    ok: detail.length,
    failed,
    detail,
    durationMs: Date.now() - started,
  };
}

/**
 * Advance one approval to its next due rung.
 *
 * The only job driven by Cloud Tasks rather than Cloud Scheduler, because it is
 * scheduled per approval at a specific moment rather than on a clock.
 */
export async function advanceApproval(input: {
  societyId: string;
  approvalId: string;
}): Promise<unknown> {
  return callApi("/internal/approvals/advance", input);
}

/**
 * Escalate complaints past their deadline. Every 15 minutes.
 *
 * Frequent because an SLA measured in hours needs a sweep measured in minutes — an
 * hourly sweep makes an 8-hour target effectively a 9-hour one.
 */
export async function slaSweep(): Promise<JobResult> {
  return forEachSociety("sla-sweep", (societyId) =>
    callApi("/internal/helpdesk/sla-sweep", { societyId }),
  );
}

/** Flag visitors who entered and never left. Hourly. */
export async function overstaySweep(): Promise<JobResult> {
  return forEachSociety("overstay-sweep", (societyId) =>
    callApi("/internal/gate/overstay-sweep", { societyId, hours: 12 }),
  );
}

/**
 * Verify every society's ledger still balances. Nightly.
 *
 * A violation here is a paging-level event, not a warning to file: it means money has
 * been recorded that does not add up, and every further entry is built on top of it.
 */
export async function ledgerInvariants(): Promise<JobResult> {
  const result = await forEachSociety("ledger-invariants", (societyId) =>
    callApi("/internal/ledger/invariants", { societyId }),
  );

  const broken = result.detail.filter(
    (d): d is { societyId: string; ok: boolean; violations: string[] } =>
      typeof d === "object" && d !== null && "ok" in d && (d as { ok: boolean }).ok === false,
  );

  if (broken.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        event: "LEDGER_INVARIANT_VIOLATION",
        severity: "critical",
        societies: broken.map((b) => ({ societyId: b.societyId, violations: b.violations })),
        detail: "The books do not balance. Investigate before any further posting.",
      }),
    );
  }

  return result;
}

/**
 * Issue this month's invoices for every society.
 *
 * Due on the 10th, a conventional grace period for Indian societies. Re-running is safe:
 * a unit already invoiced for the period is reported as `alreadyBilled` rather than
 * charged twice.
 */
export async function billingRun(opts: { dryRun?: boolean; month?: string } = {}): Promise<JobResult> {
  const now = opts.month ? new Date(`${opts.month}-01T00:00:00Z`) : new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const periodStart = new Date(Date.UTC(year, month, 1));
  const periodEnd = new Date(Date.UTC(year, month + 1, 0)); // day 0 of next month = last day
  const dueDate = new Date(Date.UTC(year, month, 10));

  const iso = (d: Date) => d.toISOString().slice(0, 10);

  return forEachSociety("billing-run", (societyId) =>
    callApi("/internal/billing/run", {
      societyId,
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      dueDate: iso(dueDate),
      ...(opts.dryRun ? { dryRun: true } : {}),
    }),
  );
}

/**
 * Create future `audit_log` partitions. Monthly.
 *
 * Not tenant-scoped — the table is shared. The failure this prevents is unglamorous and
 * total: when the rolling window runs out, every audited action starts failing at
 * midnight on the 1st.
 */
export async function auditPartitions(): Promise<unknown> {
  return callApi("/internal/maintenance/audit-partitions", {});
}
