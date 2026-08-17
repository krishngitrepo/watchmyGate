/**
 * The normalisers that decide whether an import succeeds.
 *
 * These are four lines each and they are where a real society's spreadsheet lives or
 * dies. A phone column exported from Tally contains every format a human has ever typed,
 * and an amount column contains rupee symbols, commas and the occasional space. Rejecting
 * those rows means a committee edits 400 cells by hand and does not switch.
 */

import { describe, expect, it } from "vitest";

import { normaliseAmount, normalisePhone } from "./migration.service.js";

describe("normalisePhone", () => {
  it("accepts every way a human writes an Indian mobile", () => {
    for (const raw of [
      "9900000001",
      "09900000001",
      "919900000001",
      "+919900000001",
      "+91 99000 00001",
      "+91-99000-00001",
      "  99000 00001  ",
    ]) {
      expect(normalisePhone(raw)).toBe("+919900000001", );
    }
  });

  it("rejects what is not a mobile number", () => {
    // Indian mobiles start 6-9. A landline or a truncated cell is better rejected at
    // import than stored and silently un-contactable at 7am.
    expect(normalisePhone("1234567890")).toBeNull();
    expect(normalisePhone("5900000001")).toBeNull();
    expect(normalisePhone("99000")).toBeNull();
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("not a number")).toBeNull();
  });

  it("keeps distinct numbers distinct", () => {
    expect(normalisePhone("9900000001")).not.toBe(normalisePhone("9900000002"));
  });
});

describe("normaliseAmount", () => {
  it("strips what a spreadsheet adds", () => {
    expect(normaliseAmount("₹1,23,456.50")).toBe("123456.50");
    expect(normaliseAmount("1,234")).toBe("1234");
    expect(normaliseAmount("  4500.00  ")).toBe("4500.00");
  });

  it("returns a string, never a number", () => {
    // The value goes straight into `numeric`. A float here is the one way an import
    // could put a rounding error into every flat's opening balance at once.
    const v = normaliseAmount("6497.4999");
    expect(typeof v).toBe("string");
    expect(v).toBe("6497.4999");
  });

  it("preserves precision a double would lose", () => {
    expect(normaliseAmount("99999999999999999.99")).toBe("99999999999999999.99");
  });

  it("rejects what is not an amount", () => {
    expect(normaliseAmount("")).toBeNull();
    expect(normaliseAmount("abc")).toBeNull();
    expect(normaliseAmount("1.2.3")).toBeNull();
    expect(normaliseAmount("12.345678")).toBeNull(); // more precision than numeric(18,4)
  });

  it("accepts a negative so the caller can reject it with a better message", () => {
    // Parsing and policy are separate. "-500" is a valid number and an invalid opening
    // balance, and the row should say the second thing, not "that is not a number".
    expect(normaliseAmount("-500.00")).toBe("-500.00");
  });
});
