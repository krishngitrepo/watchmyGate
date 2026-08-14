/**
 * The approval ladder.
 *
 * The brief asked for "gate approval in under 2 seconds". That is not achievable and
 * pretending otherwise designs the wrong system: the round trip includes a human being
 * finding their phone and tapping a button. What we can guarantee is our own leg of it
 * — the server acknowledges in under 800 ms and the push lands in under 3 s — and then
 * handle the case that actually decides whether a society keeps the product.
 *
 * That case is **nobody answers**. It is the single most common complaint against the
 * incumbents, and here it is a designed path rather than an edge case:
 *
 *     t=0s   push to every device on the unit
 *     t=20s  no answer  → IVR call + SMS to the primary resident
 *     t=45s  no answer  → apply the unit's standing rule
 *     t=90s  no answer  → escalate to the on-duty committee member
 *
 * Every rung fired is recorded, so "I never got a notification" is answerable with
 * evidence instead of an apology.
 *
 * This module is deliberately pure — no database, no clock, no network. The timing
 * rules are the part that must be exactly right, and pure functions let the tests say
 * so without waiting 90 real seconds.
 */

export type Rung = "push" | "ivr" | "sms" | "standing_rule" | "mc_escalation";
export type StandingAction = "auto_approve" | "ask_to_wait" | "deny";
export type VisitorCategory =
  | "guest"
  | "delivery"
  | "cab"
  | "courier"
  | "service"
  | "staff";

export interface LadderStep {
  readonly rung: Rung;
  readonly atSeconds: number;
  readonly description: string;
}

/**
 * The ladder itself.
 *
 * The gaps are chosen against how people actually behave, not round numbers. 20 s is
 * about as long as a guard will stand there before phoning the flat himself — past that
 * he stops trusting the app and reverts to the intercom, and once he does that the
 * product is dead in that society. 45 s is long enough that a resident who was reaching
 * for their phone still gets to decide for themselves. 90 s means the visitor is not
 * left standing indefinitely while nobody takes responsibility.
 */
export const LADDER: readonly LadderStep[] = [
  { rung: "push", atSeconds: 0, description: "Push to every device on the unit" },
  { rung: "ivr", atSeconds: 20, description: "IVR call and SMS to the primary resident" },
  { rung: "standing_rule", atSeconds: 45, description: "Apply the unit's standing rule" },
  { rung: "mc_escalation", atSeconds: 90, description: "Escalate to the on-duty committee member" },
];

/** Server-side acknowledgement budget. Breaching this is an incident, not a slow day. */
export const ACK_BUDGET_MS = 800;

export interface StandingRule {
  readonly id: string;
  readonly category: VisitorCategory | null;
  /** Free-text match against the visitor or company name, e.g. "Amazon". */
  readonly matcher: string | null;
  readonly action: StandingAction;
  readonly isActive: boolean;
}

export interface VisitorRequest {
  readonly category: VisitorCategory;
  readonly visitorName: string | null;
}

/**
 * Which rung is due next, given what has already fired and how long we have waited.
 *
 * Returns `null` when the ladder is exhausted — the caller then leaves the approval in
 * `escalated` rather than inventing another step.
 *
 * Driven by elapsed time rather than by a timer chain so that a worker restart, a
 * delayed Cloud Task or a duplicate delivery all converge on the same answer. Recovery
 * is just "ask again", which is the property that makes this survivable in production.
 */
export function nextRung(fired: readonly Rung[], elapsedSeconds: number): Rung | null {
  const done = new Set(fired);
  for (const step of LADDER) {
    if (done.has(step.rung)) continue;
    if (elapsedSeconds >= step.atSeconds) return step.rung;
    // Steps are in ascending time order, so the first future step ends the search.
    return null;
  }
  return null;
}

/** When the next unfired rung becomes due, in seconds from the request. Null if none. */
export function secondsUntilNextRung(fired: readonly Rung[]): number | null {
  const done = new Set(fired);
  const pending = LADDER.find((s) => !done.has(s.rung));
  return pending ? pending.atSeconds : null;
}

/**
 * Specificity of a rule. Higher wins.
 *
 * A rule naming a company ("Amazon") beats one naming a whole category ("delivery"),
 * which beats a catch-all. This is what lets a resident say "let Amazon in, but ask me
 * about other deliveries" and have it mean what they expect.
 */
function specificity(rule: StandingRule): number {
  return (rule.matcher ? 2 : 0) + (rule.category ? 1 : 0);
}

/** Safety ordering for ties. Denying is always the safe side of a coin flip. */
const ACTION_CAUTION: Record<StandingAction, number> = {
  deny: 2,
  ask_to_wait: 1,
  auto_approve: 0,
};

/**
 * Pick the standing rule that applies, or `null` if none does.
 *
 * Two properties matter more than the matching itself:
 *
 * 1. **Most specific wins**, so a company-level rule overrides a category-level one.
 * 2. **Ties resolve toward caution.** If a unit somehow holds two equally specific
 *    rules that disagree — easy to produce by adding a rule twice from two devices —
 *    the more cautious action wins. A duplicate rule must never be the reason a
 *    stranger is let in, and the resident can always approve manually. Silently
 *    granting access on a coin flip is the one outcome with no recovery.
 */
export function matchStandingRule(
  rules: readonly StandingRule[],
  request: VisitorRequest,
): StandingRule | null {
  const name = request.visitorName?.trim().toLowerCase() ?? "";

  const applicable = rules.filter((rule) => {
    if (!rule.isActive) return false;
    if (rule.category && rule.category !== request.category) return false;
    if (rule.matcher) {
      const needle = rule.matcher.trim().toLowerCase();
      // Substring, because the guard types "Amazon delivery" and the rule says "Amazon".
      if (needle === "" || !name.includes(needle)) return false;
    }
    return true;
  });

  if (applicable.length === 0) return null;

  return applicable.reduce((best, rule) => {
    const bySpecificity = specificity(rule) - specificity(best);
    if (bySpecificity !== 0) return bySpecificity > 0 ? rule : best;

    const byCaution = ACTION_CAUTION[rule.action] - ACTION_CAUTION[best.action];
    if (byCaution !== 0) return byCaution > 0 ? rule : best;

    // Fully tied: order by id so the outcome is stable across processes and replays.
    return rule.id < best.id ? rule : best;
  });
}

/**
 * What the standing rule rung resolves the approval to.
 *
 * `ask_to_wait` deliberately does NOT resolve the approval — the visitor waits and the
 * ladder continues to committee escalation. It means "I have not decided", not "no".
 */
export function outcomeOfStandingRule(
  action: StandingAction,
): { resolved: true; state: "auto_approved" | "denied" } | { resolved: false } {
  switch (action) {
    case "auto_approve":
      return { resolved: true, state: "auto_approved" };
    case "deny":
      return { resolved: true, state: "denied" };
    case "ask_to_wait":
      return { resolved: false };
  }
}

/**
 * Clock drift between a guard handset and the server, in seconds.
 *
 * Guard device clocks are routinely wrong, sometimes by hours — they are cheap, shared,
 * and nobody owns keeping them right. Every piece of business logic uses `server_ts`;
 * `device_ts` is kept only so the audit trail can show both and the difference.
 *
 * Positive means the device is running behind the server.
 */
export function driftSeconds(deviceTs: Date, serverTs: Date): number {
  return Math.round((serverTs.getTime() - deviceTs.getTime()) / 1000);
}

/** Drift beyond this is worth surfacing to the committee — the handset needs attention. */
export const DRIFT_ALERT_SECONDS = 300;
