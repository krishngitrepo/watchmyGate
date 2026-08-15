/**
 * Money arriving from the gateway.
 *
 * These need no database: they cover the two conversions where a payment can be silently
 * corrupted between Razorpay and our ledger.
 */

import { describe, expect, it } from "vitest";

import { ValidationError } from "../../common/errors.js";
import { mapMethod, paiseToRupees } from "./payments.controller.js";

describe("paise to rupees", () => {
  it("converts whole rupees", () => {
    expect(paiseToRupees(500000)).toBe("5000.00");
  });

  it("keeps paise", () => {
    expect(paiseToRupees(259999)).toBe("2599.99");
  });

  /**
   * Why this returns a STRING rather than a number.
   *
   * Not because `paise / 100` is itself inexact — for realistic amounts it is exact, and
   * a sweep of the first two million paise values found no case where it is not. The
   * danger is what the result *is*: a float. Float error does not appear in one
   * division, it accumulates across a summation, and a society's monthly collection is
   * a summation over hundreds of flats.
   *
   * So the rule is not "be careful dividing", it is "money never becomes a JS number".
   * `money()` refuses numbers outright for this reason.
   */
  it("returns a string, so the value never becomes a float", () => {
    expect(paiseToRupees(2599)).toBe("25.99");
    expect(typeof paiseToRupees(2599)).toBe("string");
  });

  it("demonstrates the accumulation this avoids", () => {
    // 250 flats each paying Rs 25.99, added as floats.
    let asFloat = 0;
    for (let i = 0; i < 250; i += 1) asFloat += 2599 / 100;

    expect(asFloat).not.toBe(6497.5);
    expect(asFloat).toBeCloseTo(6497.5, 6); // close, and wrong
    expect(asFloat.toString()).toBe("6497.499999999964");
  });

  it("handles amounts under a rupee", () => {
    expect(paiseToRupees(1)).toBe("0.01");
    expect(paiseToRupees(99)).toBe("0.99");
    expect(paiseToRupees(0)).toBe("0.00");
  });

  it("handles a large society-scale payment without losing precision", () => {
    // 12.5 lakh, the kind of figure a corpus collection reaches.
    expect(paiseToRupees(125000075)).toBe("1250000.75");
  });

  it("rejects a non-integer, which would mean the gateway sent something unexpected", () => {
    expect(() => paiseToRupees(2599.5)).toThrow(ValidationError);
  });

  it("rejects a negative amount", () => {
    expect(() => paiseToRupees(-100)).toThrow(ValidationError);
  });
});

describe("payment method mapping", () => {
  it("maps the rails we know", () => {
    expect(mapMethod("upi")).toBe("upi");
    expect(mapMethod("card")).toBe("card");
    expect(mapMethod("netbanking")).toBe("netbanking");
    expect(mapMethod("bank_transfer")).toBe("neft");
  });

  /**
   * An unrecognised rail must not lose the payment. The money genuinely arrived;
   * refusing to record it because the label is unfamiliar leaves the books wrong in a
   * worse way than an imprecise label does.
   */
  it("records an unknown method rather than dropping the payment", () => {
    expect(mapMethod("wallet")).toBe("netbanking");
    expect(mapMethod("")).toBe("netbanking");
  });
});
