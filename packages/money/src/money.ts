/**
 * Money — the one implementation, shared by server, browser and desktop.
 *
 * This package is the reason the API is TypeScript. The total a resident sees in the
 * app, the total an accountant edits in the console, and the total filed for GST are
 * all produced by this code. There is no second implementation to drift.
 *
 * ## Why not `number`
 *
 * JavaScript `Number` is a binary float. `0.1 + 0.2 === 0.30000000000000004`. Sharing a
 * calculator built on floats would make server and browser wrong *identically*, which is
 * worse than disagreeing — nothing would ever flag it. So money is `Decimal` throughout,
 * and `Money` is a branded type so a bare `number` cannot be passed by accident.
 *
 * ## Rounding
 *
 * Half-up at two decimals for anything invoiced. Indian statutory invoicing expects
 * half-up; banker's rounding would turn ₹0.125 into ₹0.12 and a committee checking
 * against their spreadsheet would report it as a bug. Intermediate values keep four
 * decimals — matching `numeric(18,4)` in Postgres — and only the final amount is
 * quantised.
 */

import Decimal from "decimal.js";

// Half-up, and enough precision that per-sq-ft maths on a 5,000-unit society never
// silently truncates.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

/** Branded so a raw `number` is a compile error, not a runtime surprise. */
export type Money = Decimal & { readonly __brand: "Money" };

export const CURRENCY = "INR" as const;

/** Storage precision — matches `numeric(18,4)`. */
const STORAGE_DP = 4;
/** Presentation and invoicing precision — rupees and paise. */
const MONEY_DP = 2;

export const ZERO = new Decimal(0) as Money;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Build a money value.
 *
 * `number` is rejected deliberately. Accepting it would reintroduce exactly the
 * floating-point error this module exists to prevent — by the time a float reaches
 * here the precision is already lost, so validating it later cannot help.
 */
export function money(value: string | Decimal): Money {
  if (typeof value === "number") {
    throw new MoneyError(
      "number is not accepted for money — pass a string or Decimal " +
        '(e.g. money("1250.50"), not money(1250.50)).',
    );
  }
  try {
    return new Decimal(value).toDecimalPlaces(
      STORAGE_DP,
      Decimal.ROUND_HALF_UP,
    ) as Money;
  } catch {
    throw new MoneyError(`Not a valid money value: ${String(value)}`);
  }
}

/** Round to rupees and paise, half-up. Use for anything presented or invoiced. */
export function quantise(value: Money | Decimal): Money {
  return new Decimal(value).toDecimalPlaces(
    MONEY_DP,
    Decimal.ROUND_HALF_UP,
  ) as Money;
}

export function add(...values: Money[]): Money {
  return values.reduce<Money>((acc, v) => acc.plus(v) as Money, ZERO);
}

export function subtract(a: Money, b: Money): Money {
  return a.minus(b) as Money;
}

export function multiply(a: Money, factor: string | Decimal): Money {
  return a.times(new Decimal(factor)) as Money;
}

export function isZero(a: Money): boolean {
  return a.isZero();
}

export function isNegative(a: Money): boolean {
  return a.isNegative();
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  return a.comparedTo(b) as -1 | 0 | 1;
}

/** Apply a percentage rate (GST, interest) and quantise. */
export function applyRate(base: Money, ratePercent: string | Decimal): Money {
  return quantise(base.times(new Decimal(ratePercent)).dividedBy(100));
}

/**
 * Split `total` across `weights` without losing or inventing a paisa.
 *
 * Naive proportional splitting silently drops the rounding remainder: ₹100 across three
 * flats gives 33.33 × 3 = ₹99.99 and a rupee vanishes. This distributes the remainder
 * one paisa at a time to the largest fractional losses first, so the parts always sum
 * exactly to the whole.
 *
 * That exactness is what makes a per-sq-ft maintenance run reconcile against the
 * society's bank statement — and a bill that does not reconcile in month one destroys
 * the committee's trust permanently.
 */
export function allocate(total: Money, weights: Decimal[]): Money[] {
  if (weights.length === 0) {
    throw new MoneyError("Cannot allocate across an empty set of weights.");
  }

  const weightTotal = weights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (weightTotal.lessThanOrEqualTo(0)) {
    throw new MoneyError("Allocation weights must sum to a positive value.");
  }

  const raw = weights.map((w) => new Decimal(total).times(w).dividedBy(weightTotal));
  const parts = raw.map((r) => quantise(r as Money));

  const target = quantise(total);
  const allocated = parts.reduce((a, b) => a.plus(b), new Decimal(0));
  let remainder = target.minus(allocated);

  if (remainder.isZero()) return parts;

  const step = remainder.isPositive() ? new Decimal("0.01") : new Decimal("-0.01");
  // Largest fractional loss corrected first — the conventional, defensible order.
  const order = raw
    .map((r, i) => ({ i, loss: r.minus(parts[i]!) }))
    .sort((a, b) =>
      remainder.isPositive()
        ? b.loss.comparedTo(a.loss)
        : a.loss.comparedTo(b.loss),
    );

  const steps = remainder.abs().dividedBy("0.01").toNumber();
  for (let n = 0; n < steps; n++) {
    const idx = order[n % order.length]!.i;
    parts[idx] = parts[idx]!.plus(step) as Money;
  }

  return parts;
}

/**
 * Convert to paise at the payment-gateway boundary only.
 *
 * Razorpay works in integer paise. Converting here rather than earlier keeps every
 * internal calculation in Decimal, so the amount charged always equals the amount
 * invoiced.
 */
export function toPaise(amount: Money): number {
  return quantise(amount).times(100).toDecimalPlaces(0).toNumber();
}

export function fromPaise(paise: number): Money {
  return money(new Decimal(paise).dividedBy(100));
}

/** Canonical string for storage and for `numeric(18,4)` binding. */
export function toDbString(amount: Money): string {
  return new Decimal(amount).toFixed(STORAGE_DP);
}

/** Indian-format display, e.g. `₹1,23,456.78`. */
export function format(amount: Money, withSymbol = true): string {
  const fixed = quantise(amount).toFixed(MONEY_DP);
  const [whole = "0", fraction = "00"] = fixed.replace("-", "").split(".");

  // Indian grouping: last three digits, then pairs. 1234567 → 12,34,567
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`
    : last3;

  const sign = new Decimal(amount).isNegative() ? "-" : "";
  return `${sign}${withSymbol ? "₹" : ""}${grouped}.${fraction}`;
}
