/**
 * Properties of the money type that the golden vectors do not cover — chiefly that
 * float can never get in.
 */

import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { MoneyError, ZERO, allocate, money, quantise, toDbString } from "./money.js";

describe("float is refused at the boundary", () => {
  it("rejects a number literal", () => {
    // The reason this package exists: 0.1 + 0.2 !== 0.3 in binary floating point, and
    // by the time a float reaches here the precision is already gone.
    expect(() => money(1250.5 as unknown as string)).toThrow(MoneyError);
  });

  it("demonstrates the bug it prevents", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(money("0.1").plus(money("0.2")).toFixed(2)).toBe("0.30");
  });

  it("accepts strings and Decimals", () => {
    expect(money("1250.50").toFixed(4)).toBe("1250.5000");
    expect(money(new Decimal("1250.50")).toFixed(4)).toBe("1250.5000");
  });
});

describe("allocation invariant holds for arbitrary splits", () => {
  it("sum of parts equals the whole across many random cases", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const total = money(new Decimal(seed).times("13.37").toFixed(2));
      const count = (seed % 7) + 1;
      const weights = Array.from(
        { length: count },
        (_, i) => new Decimal(((seed * (i + 3)) % 900) + 100),
      );

      const parts = allocate(total, weights);
      const sum = parts.reduce((a, b) => a.plus(b), new Decimal(0));

      expect(sum.toFixed(2)).toBe(quantise(total).toFixed(2));
      expect(parts).toHaveLength(count);
    }
  });

  it("refuses an empty or zero-weight split rather than dividing by zero", () => {
    expect(() => allocate(money("100"), [])).toThrow(MoneyError);
    expect(() => allocate(money("100"), [new Decimal(0), new Decimal(0)])).toThrow(
      MoneyError,
    );
  });
});

describe("database representation", () => {
  it("always writes four decimal places to match numeric(18,4)", () => {
    expect(toDbString(money("1250.5"))).toBe("1250.5000");
    expect(toDbString(ZERO)).toBe("0.0000");
    expect(toDbString(money("0.0001"))).toBe("0.0001");
  });
});
