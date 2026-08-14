/**
 * Billing rules — GST, formulas, late fees, invoice totals.
 *
 * Every function here is pure: no database, no clock, no I/O. That is deliberate.
 * It means `golden-vectors.json` fully specifies the behaviour, so the Dart
 * implementation in the Flutter apps can be checked against exactly the same fixture
 * and neither side can drift without a red build.
 *
 * This module runs unchanged in the API, the React admin console and the Tauri desktop
 * app. A live total while an accountant edits a bill is computed by the same code that
 * issues the invoice and files the GST.
 */

import Decimal from "decimal.js";

import {
  ZERO,
  applyRate,
  money,
  quantise,
  type Money,
} from "./money.js";

export type BillingFormula =
  | "flat"
  | "per_sqft"
  | "per_bhk"
  | "per_meter"
  | "percentage"
  | "manual";

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

/** What a formula may consider about a flat. */
export interface UnitFacts {
  carpetAreaSqft?: Decimal;
  bhk?: number;
  meterReadingUnits?: Decimal;
  baseAmount?: Money;
}

export interface ChargeSpec {
  code: string;
  name: string;
  formula: BillingFormula;
  rate: Money;
  gstApplicable?: boolean;
  gstRate?: Decimal;
}

export interface ComputedLine {
  code: string;
  description: string;
  quantity: Decimal;
  rate: Money;
  amount: Money;
  gstRate: Decimal;
  gstAmount: Money;
}

/**
 * The statutory GST test for society maintenance.
 *
 * GST applies only when the monthly charge per member exceeds ₹7,500 **and** the
 * society's annual turnover exceeds ₹20 lakh. Both conditions, not either — societies
 * routinely get this wrong and over-charge their members, so it is encoded as a rule
 * with the thresholds as data, since legislation moves.
 */
export interface GstContext {
  monthlyThresholdPerMember: Money;
  annualTurnoverThreshold: Money;
  societyTurnover: Money;
  rate: Decimal;
}

export const DEFAULT_GST_CONTEXT: GstContext = {
  monthlyThresholdPerMember: money("7500"),
  annualTurnoverThreshold: money("2000000"),
  societyTurnover: ZERO,
  rate: new Decimal("18"),
};

/**
 * Apply one charge formula to one flat.
 *
 * Throws rather than silently billing zero when required data is missing. A flat with
 * no recorded carpet area must not quietly receive a ₹0 maintenance bill — that is
 * discovered at the annual audit, not before.
 */
export function computeLine(spec: ChargeSpec, facts: UnitFacts): ComputedLine {
  const rate = money(spec.rate);
  let quantity: Decimal;
  let amount: Money;

  switch (spec.formula) {
    case "flat":
      quantity = new Decimal(1);
      amount = rate;
      break;

    case "per_sqft":
      if (facts.carpetAreaSqft === undefined) {
        throw new BillingError(
          `Cannot bill "${spec.name}": this flat has no carpet area recorded.`,
        );
      }
      quantity = facts.carpetAreaSqft;
      amount = quantise(rate.times(quantity) as Money);
      break;

    case "per_bhk":
      if (facts.bhk === undefined) {
        throw new BillingError(
          `Cannot bill "${spec.name}": this flat has no BHK recorded.`,
        );
      }
      quantity = new Decimal(facts.bhk);
      amount = quantise(rate.times(quantity) as Money);
      break;

    case "per_meter":
      if (facts.meterReadingUnits === undefined) {
        throw new BillingError(
          `Cannot bill "${spec.name}": no meter reading for this period.`,
        );
      }
      quantity = facts.meterReadingUnits;
      amount = quantise(rate.times(quantity) as Money);
      break;

    case "percentage":
      if (facts.baseAmount === undefined) {
        throw new BillingError(
          `Cannot bill "${spec.name}": no base amount to take a percentage of.`,
        );
      }
      quantity = new Decimal(1);
      amount = applyRate(facts.baseAmount, rate);
      break;

    case "manual":
      if (facts.baseAmount === undefined) {
        throw new BillingError(`Cannot bill "${spec.name}": no amount entered.`);
      }
      quantity = new Decimal(1);
      amount = money(facts.baseAmount);
      break;

    default: {
      const exhaustive: never = spec.formula;
      throw new BillingError(`Unknown billing formula: ${String(exhaustive)}`);
    }
  }

  return {
    code: spec.code,
    description: spec.name,
    quantity,
    rate,
    amount,
    gstRate: spec.gstApplicable ? (spec.gstRate ?? new Decimal("18")) : new Decimal(0),
    gstAmount: ZERO, // filled by applyGst once the monthly total is known
  };
}

/** Both statutory conditions must hold. */
export function gstApplies(monthlyTotalPerMember: Money, ctx: GstContext): boolean {
  return (
    monthlyTotalPerMember.greaterThan(ctx.monthlyThresholdPerMember) &&
    ctx.societyTurnover.greaterThan(ctx.annualTurnoverThreshold)
  );
}

/**
 * Add GST to eligible lines, but only if the society-level test passes.
 *
 * The threshold uses the **total monthly charge for the member**, not the individual
 * line: ₹6,000 maintenance plus ₹2,000 water crosses ₹7,500 together even though
 * neither does alone.
 */
export function applyGst(lines: ComputedLine[], ctx: GstContext): ComputedLine[] {
  const monthlyTotal = lines.reduce<Money>(
    (acc, l) => acc.plus(l.amount) as Money,
    ZERO,
  );

  const applies = gstApplies(monthlyTotal, ctx);

  return lines.map((line) => ({
    ...line,
    gstRate: applies ? line.gstRate : new Decimal(0),
    gstAmount:
      applies && !line.gstRate.isZero() ? applyRate(line.amount, line.gstRate) : ZERO,
  }));
}

/**
 * Simple (not compound) interest on overdue maintenance.
 *
 * Simple interest is deliberate: most society bye-laws specify it, and compounding a
 * maintenance arrear is the kind of thing that gets challenged at an AGM. A part month
 * counts as a whole month, which is the common convention — and must be stated on the
 * bill so it is not a surprise.
 */
export function lateFee(
  outstanding: Money,
  dueDate: Date,
  asOf: Date,
  opts: { percentPerMonth: Decimal; graceDays?: number },
): Money {
  if (opts.percentPerMonth.lessThanOrEqualTo(0) || outstanding.lessThanOrEqualTo(0)) {
    return ZERO;
  }

  const graceMs = (opts.graceDays ?? 0) * 24 * 60 * 60 * 1000;
  const effectiveDue = new Date(dueDate.getTime() + graceMs);
  if (asOf.getTime() <= effectiveDue.getTime()) return ZERO;

  const daysLate = Math.floor(
    (asOf.getTime() - effectiveDue.getTime()) / (24 * 60 * 60 * 1000),
  );
  const monthsLate = Math.ceil(daysLate / 30);

  return quantise(
    outstanding.times(opts.percentPerMonth).dividedBy(100).times(monthsLate) as Money,
  );
}

export interface InvoiceTotals {
  subtotal: Money;
  gstAmount: Money;
  lateFee: Money;
  total: Money;
}

/**
 * Sum an invoice.
 *
 * Totals come from the already-quantised line amounts, so the printed lines always add
 * up to the printed total. Summing unrounded values and rounding at the end would
 * produce a bill whose own lines do not tally — the first thing an accountant notices,
 * and the fastest way to lose a society's confidence.
 */
export function totalInvoice(
  lines: ComputedLine[],
  opts: { lateFeeAmount?: Money } = {},
): InvoiceTotals {
  const subtotal = lines.reduce<Money>((a, l) => a.plus(l.amount) as Money, ZERO);
  const gstAmount = lines.reduce<Money>((a, l) => a.plus(l.gstAmount) as Money, ZERO);
  const fee = quantise(opts.lateFeeAmount ?? ZERO);

  return {
    subtotal: quantise(subtotal),
    gstAmount: quantise(gstAmount),
    lateFee: fee,
    total: quantise(subtotal.plus(gstAmount).plus(fee) as Money),
  };
}
