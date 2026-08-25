/**
 * An amount, written out in words, in the Indian system.
 *
 * Not decoration. A receipt without the amount in words is not a receipt an Indian
 * auditor recognises, and the reason is older than the software: a figure can be altered
 * with a pen, and "Fourteen Thousand Two Hundred Eighty" cannot. Every printed receipt
 * book in the country carries the line, so ours does too.
 *
 * The Indian system groups differently from the Western one - crore, lakh, thousand,
 * hundred, rather than billion, million, thousand - so this cannot be borrowed from a
 * generic library without producing "one hundred twenty-three thousand" where a society's
 * books say "one lakh twenty-three thousand".
 */

import { Decimal } from "decimal.js";

import type { Money } from "./money.js";

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

/** 0-99. The teens are irregular in English, so they get their own entries above. */
function underHundred(value: number): string {
  if (value < 20) return ONES[value] ?? "";
  const tens = TENS[Math.floor(value / 10)] ?? "";
  const ones = ONES[value % 10] ?? "";
  return ones ? `${tens} ${ones}` : tens;
}

function underThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(underHundred(rest));
  return parts.join(" ");
}

/**
 * A whole number in words, Indian grouping.
 *
 * Stops at crore rather than going on to arab and kharab: a society's largest realistic
 * figure is a corpus fund in the tens of crores, and "One Thousand Two Hundred Crore"
 * reads correctly for anything beyond that anyway.
 */
export function numberToIndianWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("An amount in words must be a non-negative finite number.");
  }
  const whole = Math.floor(value);
  if (whole === 0) return "Zero";

  const crore = Math.floor(whole / 10000000);
  const lakh = Math.floor((whole % 10000000) / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const rest = whole % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));
  return parts.join(" ");
}

/**
 * The full line as it appears on a receipt.
 *
 * Paise are included only when there are any, which matches how receipts are actually
 * written: "Rupees Five Thousand Only", not "Rupees Five Thousand and Zero Paise Only".
 * A negative amount - a refund - is written as such rather than silently losing its sign.
 */
export function amountInWords(amount: Money | Decimal | string): string {
  const value = new Decimal(amount);
  const negative = value.isNegative();
  const absolute = value.abs();

  const rupees = absolute.floor().toNumber();
  // Round to paise first: 0.005 must not become "Zero Paise".
  const paise = absolute.minus(absolute.floor()).times(100).toDecimalPlaces(0).toNumber();

  // Rounding the fraction can carry: 999.999 is One Thousand Rupees, not 999 and 100 paise.
  const carriedRupees = paise === 100 ? rupees + 1 : rupees;
  const carriedPaise = paise === 100 ? 0 : paise;

  const head = `Rupees ${numberToIndianWords(carriedRupees)}`;
  const tail = carriedPaise ? ` and ${underHundred(carriedPaise)} Paise` : "";
  const sign = negative ? "Minus " : "";
  return `${sign}${head}${tail} Only`;
}
