/**
 * Runs the golden vectors.
 *
 * `golden-vectors.json` is the specification of WatchMyGate's billing maths. The Dart
 * suite in the Flutter apps runs the *same file*, so if this passes and that passes,
 * the two implementations agree by construction rather than by hope.
 *
 * When a billing rule legitimately changes, the vector file changes first and both
 * suites go red until both implementations follow. That is the intended workflow.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  applyGst,
  computeLine,
  gstApplies,
  lateFee,
  totalInvoice,
  type ChargeSpec,
  type ComputedLine,
  type UnitFacts,
} from "./billing.js";
import {
  DEFAULT_GST_CONTEXT,
} from "./billing.js";
import {
  ZERO,
  applyRate,
  allocate,
  format,
  money,
  quantise,
  toPaise,
} from "./money.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "golden-vectors.json"), "utf8"),
) as Record<string, any>;

describe("rounding — half-up, not banker's", () => {
  for (const c of vectors.rounding.cases) {
    it(`${c.input} → ${c.expected}`, () => {
      expect(quantise(money(c.input)).toFixed(2)).toBe(c.expected);
    });
  }
});

describe("applyRate", () => {
  for (const c of vectors.applyRate.cases) {
    it(`${c.base} @ ${c.ratePercent}% → ${c.expected}`, () => {
      expect(applyRate(money(c.base), c.ratePercent).toFixed(2)).toBe(c.expected);
    });
  }
});

describe("allocate — never loses or invents a paisa", () => {
  for (const c of vectors.allocate.cases) {
    it(c.name, () => {
      const parts = allocate(
        money(c.total),
        c.weights.map((w: string) => new Decimal(w)),
      );
      expect(parts.map((p) => p.toFixed(2))).toEqual(c.expected);

      // The invariant that actually matters, restated independently of the fixture.
      const sum = parts.reduce((a, b) => a.plus(b), new Decimal(0));
      expect(sum.toFixed(2)).toBe(quantise(money(c.total)).toFixed(2));
    });
  }
});

describe("computeLine", () => {
  const toFacts = (f: Record<string, unknown>): UnitFacts => ({
    ...(f.carpetAreaSqft !== undefined
      ? { carpetAreaSqft: new Decimal(f.carpetAreaSqft as string) }
      : {}),
    ...(f.bhk !== undefined ? { bhk: f.bhk as number } : {}),
    ...(f.meterReadingUnits !== undefined
      ? { meterReadingUnits: new Decimal(f.meterReadingUnits as string) }
      : {}),
    ...(f.baseAmount !== undefined ? { baseAmount: money(f.baseAmount as string) } : {}),
  });

  const toSpec = (s: Record<string, unknown>): ChargeSpec => ({
    code: s.code as string,
    name: s.name as string,
    formula: s.formula as ChargeSpec["formula"],
    rate: money(s.rate as string),
  });

  for (const c of vectors.computeLine.cases) {
    it(c.name, () => {
      const line = computeLine(toSpec(c.spec), toFacts(c.facts));
      expect(line.amount.toFixed(2)).toBe(c.expected.amount);
      expect(line.quantity.toString()).toBe(new Decimal(c.expected.quantity).toString());
    });
  }

  describe("refuses rather than billing zero", () => {
    for (const c of vectors.computeLine.errorCases) {
      it(c.name, () => {
        expect(() => computeLine(toSpec(c.spec), toFacts(c.facts))).toThrow(
          new RegExp(c.expectedErrorContains, "i"),
        );
      });
    }
  });
});

describe("gstApplies — both statutory conditions", () => {
  for (const c of vectors.gstApplies.cases) {
    it(c.name, () => {
      const result = gstApplies(money(c.monthlyTotal), {
        ...DEFAULT_GST_CONTEXT,
        societyTurnover: money(c.societyTurnover),
      });
      expect(result).toBe(c.expected);
    });
  }
});

describe("applyGst — threshold uses the member's total, not the line", () => {
  for (const c of vectors.applyGst.cases) {
    it(c.name, () => {
      const lines: ComputedLine[] = c.lines.map((l: any, i: number) => ({
        code: `L${i}`,
        description: `Line ${i}`,
        quantity: new Decimal(1),
        rate: money(l.amount),
        amount: money(l.amount),
        gstRate: new Decimal(l.gstRate),
        gstAmount: ZERO,
      }));

      const result = applyGst(lines, {
        ...DEFAULT_GST_CONTEXT,
        societyTurnover: money(c.societyTurnover),
      });

      expect(result.map((l) => l.gstAmount.toFixed(2))).toEqual(c.expectedGst);
    });
  }
});

describe("lateFee — simple interest, part month counts as whole", () => {
  for (const c of vectors.lateFee.cases) {
    it(c.name, () => {
      const result = lateFee(
        money(c.outstanding),
        new Date(`${c.dueDate}T00:00:00Z`),
        new Date(`${c.asOf}T00:00:00Z`),
        { percentPerMonth: new Decimal(c.percentPerMonth), graceDays: c.graceDays },
      );
      expect(result.toFixed(2)).toBe(c.expected);
    });
  }
});

describe("totalInvoice — printed lines must add up to the printed total", () => {
  for (const c of vectors.totalInvoice.cases) {
    it(c.name, () => {
      const lines: ComputedLine[] = c.lines.map((l: any, i: number) => ({
        code: `L${i}`,
        description: `Line ${i}`,
        quantity: new Decimal(1),
        rate: money(l.amount),
        amount: money(l.amount),
        gstRate: new Decimal(0),
        gstAmount: money(l.gstAmount),
      }));

      const totals = totalInvoice(lines, { lateFeeAmount: money(c.lateFeeAmount) });

      expect(totals.subtotal.toFixed(2)).toBe(c.expected.subtotal);
      expect(totals.gstAmount.toFixed(2)).toBe(c.expected.gstAmount);
      expect(totals.lateFee.toFixed(2)).toBe(c.expected.lateFee);
      expect(totals.total.toFixed(2)).toBe(c.expected.total);
    });
  }
});

describe("toPaise — gateway boundary", () => {
  for (const c of vectors.toPaise.cases) {
    it(`${c.amount} → ${c.expected}`, () => {
      expect(toPaise(money(c.amount))).toBe(c.expected);
    });
  }
});

describe("format — Indian digit grouping", () => {
  for (const c of vectors.format.cases) {
    it(`${c.amount} → ${c.expected}`, () => {
      expect(format(money(c.amount))).toBe(c.expected);
    });
  }
});
