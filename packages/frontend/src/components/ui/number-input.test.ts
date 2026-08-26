import { describe, expect, test } from "bun:test";
import { parseDecimalInput } from "./number-input";

describe("parseDecimalInput", () => {
  test("accepts a comma as the decimal separator", () => {
    // The regression this exists for: the comma used to be dropped, so 71,48
    // silently became 7148.
    expect(parseDecimalInput("71,48", 2)).toBe(71.48);
    expect(parseDecimalInput("0,5", 2)).toBe(0.5);
    expect(parseDecimalInput("1234,56", 2)).toBe(1234.56);
  });

  test("still accepts a dot", () => {
    expect(parseDecimalInput("71.48", 2)).toBe(71.48);
    expect(parseDecimalInput("0.5", 2)).toBe(0.5);
  });

  test("reads grouped input in either convention", () => {
    expect(parseDecimalInput("1.234,56", 2)).toBe(1234.56);
    expect(parseDecimalInput("1,234.56", 2)).toBe(1234.56);
    expect(parseDecimalInput("1.234.567,89", 2)).toBe(1234567.89);
    expect(parseDecimalInput("1,234,567.89", 2)).toBe(1234567.89);
  });

  test("treats a lone separator before three digits as grouping in a money field", () => {
    expect(parseDecimalInput("1.234", 2)).toBe(1234);
    expect(parseDecimalInput("1,234", 2)).toBe(1234);
  });

  test("but keeps three decimals when the field allows them", () => {
    expect(parseDecimalInput("1.234", 3)).toBe(1.234);
    expect(parseDecimalInput("1,234", 3)).toBe(1.234);
    expect(parseDecimalInput("1.234", undefined)).toBe(1.234);
  });

  test("handles plain integers", () => {
    expect(parseDecimalInput("42", 2)).toBe(42);
    expect(parseDecimalInput("0", 2)).toBe(0);
  });

  test("handles negatives", () => {
    expect(parseDecimalInput("-71,48", 2)).toBe(-71.48);
    expect(parseDecimalInput("-1.234,56", 2)).toBe(-1234.56);
    expect(parseDecimalInput("-5", 2)).toBe(-5);
  });

  test("copes with a leading or trailing separator", () => {
    expect(parseDecimalInput(",5", 2)).toBe(0.5);
    expect(parseDecimalInput(".5", 2)).toBe(0.5);
    expect(parseDecimalInput("5,", 2)).toBe(5);
    expect(parseDecimalInput("5.", 2)).toBe(5);
  });

  test("strips currency symbols and spaces from pasted values", () => {
    expect(parseDecimalInput("€ 71,48", 2)).toBe(71.48);
    expect(parseDecimalInput("1 234,56", 2)).toBe(1234.56);
    expect(parseDecimalInput("71,48 EUR", 2)).toBe(71.48);
  });

  test("returns NaN for input with no digits, so the caller can fall back", () => {
    expect(parseDecimalInput("")).toBeNaN();
    expect(parseDecimalInput("   ")).toBeNaN();
    expect(parseDecimalInput("abc")).toBeNaN();
    expect(parseDecimalInput(",")).toBeNaN();
    expect(parseDecimalInput("-")).toBeNaN();
  });

  test("more decimals than the field allows are kept for the caller to round", () => {
    // Rounding is the input component's job on blur, not the parser's.
    expect(parseDecimalInput("1,2345", 2)).toBe(1.2345);
  });
});
