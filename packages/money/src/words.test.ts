/**
 * Amounts in words, in the Indian system.
 *
 * The cases that matter are the ones where a Western-grouping library gets it wrong:
 * anything at or above a lakh.
 */

import { describe, expect, it } from "vitest";

import { money } from "./money.js";
import { amountInWords, numberToIndianWords } from "./words.js";

describe("Indian grouping, not Western", () => {
  it("says lakh, not hundred thousand", () => {
    expect(numberToIndianWords(123456)).toBe("One Lakh Twenty Three Thousand Four Hundred Fifty Six");
  });

  it("says crore", () => {
    expect(numberToIndianWords(12345678)).toBe(
      "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight",
    );
  });

  it("handles a corpus fund without inventing a unit above crore", () => {
    expect(numberToIndianWords(1200000000)).toBe("One Hundred Twenty Crore");
  });
});

describe("the irregular parts of English", () => {
  it("gets the teens right", () => {
    expect(numberToIndianWords(15)).toBe("Fifteen");
    expect(numberToIndianWords(19)).toBe("Nineteen");
  });

  it("gets the tens right", () => {
    expect(numberToIndianWords(40)).toBe("Forty");
    expect(numberToIndianWords(90)).toBe("Ninety");
  });

  it("skips absent groups rather than saying zero", () => {
    expect(numberToIndianWords(1000005)).toBe("Ten Lakh Five");
  });
});

describe("the receipt line", () => {
  it("omits paise when there are none", () => {
    expect(amountInWords(money("5000"))).toBe("Rupees Five Thousand Only");
  });

  it("states paise when there are some", () => {
    expect(amountInWords(money("14280.50"))).toBe(
      "Rupees Fourteen Thousand Two Hundred Eighty and Fifty Paise Only",
    );
  });

  it("carries a rounded fraction into the rupees", () => {
    // 999.999 must not read as "Nine Hundred Ninety Nine and One Hundred Paise".
    expect(amountInWords(money("999.999"))).toBe("Rupees One Thousand Only");
  });

  it("writes zero rather than an empty string", () => {
    expect(amountInWords(money("0"))).toBe("Rupees Zero Only");
  });

  it("keeps the sign on a refund", () => {
    expect(amountInWords(money("-250"))).toBe("Minus Rupees Two Hundred Fifty Only");
  });
});
