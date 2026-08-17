/**
 * Plate normalisation.
 *
 * This is four lines of code and the most consequential four lines in the parking
 * module. Every gate lookup goes through it, and a miss means a resident is stopped at
 * their own gate — the commonest complaint about plate-based systems in this market.
 *
 * The cases below are all real ways the same car gets written by different guards on
 * different shifts.
 */

import { describe, expect, it } from "vitest";

import { normalisePlate } from "./parking.service.js";

describe("normalisePlate", () => {
  it("collapses every spelling of one plate to the same key", () => {
    const forms = [
      "KA05MJ9876",
      "KA 05 MJ 9876",
      "ka-05-mj-9876",
      "KA.05.MJ.9876",
      "  ka05 mj9876  ",
      "KA/05/MJ/9876",
    ];
    const normalised = new Set(forms.map(normalisePlate));
    expect(normalised.size).toBe(1);
    expect([...normalised][0]).toBe("KA05MJ9876");
  });

  it("uppercases", () => {
    expect(normalisePlate("mh12ab1234")).toBe("MH12AB1234");
  });

  it("keeps distinct plates distinct", () => {
    expect(normalisePlate("KA05MJ9876")).not.toBe(normalisePlate("KA05MJ9875"));
  });

  /**
   * Deliberately permissive. BH-series, military, diplomatic, dealer-temporary and older
   * state formats all differ, and a regex that rejects a legitimate plate leaves a
   * resident unable to register at all — a worse failure than accepting an odd string.
   */
  it("accepts formats a strict Indian-plate regex would reject", () => {
    expect(normalisePlate("22 BH 1234 AA")).toBe("22BH1234AA");
    expect(normalisePlate("DL-1-CAF-4321")).toBe("DL1CAF4321");
    expect(normalisePlate("11 CD 5")).toBe("11CD5");
  });

  it("strips characters that could smuggle in a wildcard", () => {
    // The normalised value reaches a WHERE clause through a bound parameter, but a plate
    // that can carry % or _ would still make an exact-match lookup behave oddly if the
    // query ever became a LIKE.
    expect(normalisePlate("KA05%MJ_9876")).toBe("KA05MJ9876");
    expect(normalisePlate("KA05'; DROP TABLE vehicles--")).toBe("KA05DROPTABLEVEHICLES");
  });

  it("is idempotent", () => {
    const once = normalisePlate("ka 05 mj 9876");
    expect(normalisePlate(once)).toBe(once);
  });
});
