/**
 * Approval ladder timing and standing-rule resolution.
 *
 * Runs with no database and no clock — the whole module is pure, which is why a 90
 * second escalation can be tested in a millisecond.
 */

import { describe, expect, it } from "vitest";

import {
  driftSeconds,
  LADDER,
  matchStandingRule,
  nextRung,
  outcomeOfStandingRule,
  secondsUntilNextRung,
  type Rung,
  type StandingRule,
} from "./ladder.js";

function rule(over: Partial<StandingRule> & { id: string }): StandingRule {
  return {
    category: null,
    matcher: null,
    action: "auto_approve",
    isActive: true,
    ...over,
  };
}

describe("ladder timing", () => {
  it("fires push immediately", () => {
    expect(nextRung([], 0)).toBe("push");
  });

  it("does not fire IVR before 20 seconds", () => {
    expect(nextRung(["push"], 19)).toBeNull();
    expect(nextRung(["push"], 20)).toBe("ivr");
  });

  it("walks the full ladder in order", () => {
    const fired: Rung[] = [];
    for (const at of [0, 20, 45, 90]) {
      const due = nextRung(fired, at);
      expect(due).not.toBeNull();
      fired.push(due!);
    }
    expect(fired).toEqual(["push", "ivr", "standing_rule", "mc_escalation"]);
  });

  it("returns null once the ladder is exhausted rather than inventing a step", () => {
    const all = LADDER.map((s) => s.rung);
    expect(nextRung(all, 10_000)).toBeNull();
  });

  /**
   * The recovery property. A worker restart, a delayed Cloud Task or a duplicate
   * delivery must all converge on the same answer, because the ladder is driven by
   * elapsed time rather than by a chain of timers.
   */
  it("catches up correctly after a long outage instead of replaying every rung", () => {
    // Nothing has fired and 200 seconds have passed. The next thing owed is the FIRST
    // unfired rung, not the last one — the resident still gets their push.
    expect(nextRung([], 200)).toBe("push");
    expect(nextRung(["push"], 200)).toBe("ivr");
    expect(nextRung(["push", "ivr"], 200)).toBe("standing_rule");
  });

  it("never re-fires a rung that already fired", () => {
    expect(nextRung(["push", "ivr"], 25)).toBeNull();
  });

  it("reports when the next rung is due, for scheduling", () => {
    expect(secondsUntilNextRung([])).toBe(0);
    expect(secondsUntilNextRung(["push"])).toBe(20);
    expect(secondsUntilNextRung(["push", "ivr"])).toBe(45);
    expect(secondsUntilNextRung(LADDER.map((s) => s.rung))).toBeNull();
  });
});

describe("standing rules", () => {
  it("returns null when the unit has no rules", () => {
    expect(matchStandingRule([], { category: "delivery", visitorName: "Ravi" })).toBeNull();
  });

  it("matches on category", () => {
    const rules = [rule({ id: "a", category: "delivery", action: "auto_approve" })];
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: "Ravi" })?.id,
    ).toBe("a");
    expect(matchStandingRule(rules, { category: "guest", visitorName: "Ravi" })).toBeNull();
  });

  it("matches a company name as a substring, as the guard actually types it", () => {
    const rules = [rule({ id: "a", matcher: "Amazon" })];
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: "Amazon delivery" })
        ?.id,
    ).toBe("a");
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: "amazon" })?.id,
    ).toBe("a");
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: "Flipkart" }),
    ).toBeNull();
  });

  it("prefers the company rule over the category rule", () => {
    // "Let Amazon in, but ask me about other deliveries."
    const rules = [
      rule({ id: "category", category: "delivery", action: "ask_to_wait" }),
      rule({ id: "company", matcher: "Amazon", action: "auto_approve" }),
    ];
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: "Amazon" })?.id,
    ).toBe("company");
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: "Flipkart" })?.id,
    ).toBe("category");
  });

  it("ignores inactive rules", () => {
    const rules = [rule({ id: "a", category: "delivery", isActive: false })];
    expect(matchStandingRule(rules, { category: "delivery", visitorName: "x" })).toBeNull();
  });

  /**
   * The safety property. Duplicate rules are easy to create — two family members adding
   * the same rule from two phones. If they disagree, a coin flip must not be the reason
   * a stranger is admitted.
   */
  it("resolves an equally specific conflict toward the more cautious action", () => {
    const rules = [
      rule({ id: "aaa", category: "guest", action: "auto_approve" }),
      rule({ id: "zzz", category: "guest", action: "deny" }),
    ];
    const picked = matchStandingRule(rules, { category: "guest", visitorName: "Stranger" });
    expect(picked?.action).toBe("deny");

    // And not because of id ordering — reversing the ids gives the same answer.
    const reversed = [
      rule({ id: "zzz", category: "guest", action: "auto_approve" }),
      rule({ id: "aaa", category: "guest", action: "deny" }),
    ];
    expect(
      matchStandingRule(reversed, { category: "guest", visitorName: "Stranger" })?.action,
    ).toBe("deny");
  });

  it("prefers ask_to_wait over auto_approve in a tie", () => {
    const rules = [
      rule({ id: "a", category: "guest", action: "auto_approve" }),
      rule({ id: "b", category: "guest", action: "ask_to_wait" }),
    ];
    expect(
      matchStandingRule(rules, { category: "guest", visitorName: "x" })?.action,
    ).toBe("ask_to_wait");
  });

  it("is stable when two identical rules fully tie", () => {
    const rules = [
      rule({ id: "bbb", category: "guest", action: "deny" }),
      rule({ id: "aaa", category: "guest", action: "deny" }),
    ];
    expect(matchStandingRule(rules, { category: "guest", visitorName: "x" })?.id).toBe(
      "aaa",
    );
  });

  it("does not match a company rule when the visitor has no name", () => {
    const rules = [rule({ id: "a", matcher: "Amazon" })];
    expect(
      matchStandingRule(rules, { category: "delivery", visitorName: null }),
    ).toBeNull();
  });
});

describe("standing rule outcomes", () => {
  it("auto_approve resolves the approval", () => {
    expect(outcomeOfStandingRule("auto_approve")).toEqual({
      resolved: true,
      state: "auto_approved",
    });
  });

  it("deny resolves the approval", () => {
    expect(outcomeOfStandingRule("deny")).toEqual({ resolved: true, state: "denied" });
  });

  /**
   * "Ask them to wait" means the resident has not decided. The ladder must continue to
   * committee escalation rather than treating indecision as a refusal — otherwise a
   * resident in a meeting silently turns away their own guest.
   */
  it("ask_to_wait does NOT resolve, so escalation still happens", () => {
    expect(outcomeOfStandingRule("ask_to_wait")).toEqual({ resolved: false });
  });
});

describe("clock drift", () => {
  it("is positive when the guard handset is running behind", () => {
    const device = new Date("2026-08-14T10:00:00Z");
    const server = new Date("2026-08-14T10:02:00Z");
    expect(driftSeconds(device, server)).toBe(120);
  });

  it("is negative when the handset is ahead", () => {
    const device = new Date("2026-08-14T10:05:00Z");
    const server = new Date("2026-08-14T10:00:00Z");
    expect(driftSeconds(device, server)).toBe(-300);
  });

  it("handles a device clock that is hours out, which is the normal case", () => {
    const device = new Date("2026-08-14T04:00:00Z");
    const server = new Date("2026-08-14T10:00:00Z");
    expect(driftSeconds(device, server)).toBe(21_600);
  });
});
