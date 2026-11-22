import { describe, expect, test } from "bun:test";
import { MoneyError, formatAmount, parseAmount } from "./index";

describe("M-MONEY parseAmount", () => {
  test("parses whole and two-decimal amounts into integer cents", () => {
    expect(parseAmount("12")).toBe(1200);
    expect(parseAmount("12.34")).toBe(1234);
    expect(parseAmount("12,34")).toBe(1234);
    expect(parseAmount(" 0 ")).toBe(0);
  });

  test("rejects empty amounts", () => {
    expect(() => parseAmount("")).toThrow(MoneyError);
    expect(() => parseAmount("   ")).toThrow("amount must not be empty");
  });

  test("rejects non-numeric and over-precise amounts", () => {
    expect(() => parseAmount("abc")).toThrow(MoneyError);
    expect(() => parseAmount("12.345")).toThrow(MoneyError);
  });

  test("rejects negative amounts", () => {
    expect(() => parseAmount("-1")).toThrow("amount must not be negative");
  });
});

describe("M-MONEY formatAmount", () => {
  test("formats integer cents with two decimals", () => {
    expect(formatAmount(1234)).toBe("12.34");
    expect(formatAmount(5)).toBe("0.05");
    expect(formatAmount(0)).toBe("0.00");
  });

  test("rejects negative and fractional cents", () => {
    expect(() => formatAmount(-1)).toThrow(MoneyError);
    expect(() => formatAmount(1.5)).toThrow(MoneyError);
  });
});
