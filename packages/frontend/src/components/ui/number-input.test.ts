import { describe, expect, test } from "bun:test";
import { decimalSeparatorFor, formatForDisplay, parseDecimalInput } from "./number-input";

describe("parseDecimalInput", () => {
  test("accepts a comma as the decimal separator", () => {
    // The regression this exists for: the comma used to be dropped, so 71,48
    // silently became 7148.
    expect(parseDecimalInput("71,48", { decimals: 2 })).toBe(71.48);
    expect(parseDecimalInput("0,5", { decimals: 2 })).toBe(0.5);
    expect(parseDecimalInput("1234,56", { decimals: 2 })).toBe(1234.56);
  });

  test("still accepts a dot", () => {
    expect(parseDecimalInput("71.48", { decimals: 2 })).toBe(71.48);
    expect(parseDecimalInput("0.5", { decimals: 2 })).toBe(0.5);
  });

  test("reads grouped input in either convention", () => {
    expect(parseDecimalInput("1.234,56", { decimals: 2 })).toBe(1234.56);
    expect(parseDecimalInput("1,234.56", { decimals: 2 })).toBe(1234.56);
    expect(parseDecimalInput("1.234.567,89", { decimals: 2 })).toBe(1234567.89);
    expect(parseDecimalInput("1,234,567.89", { decimals: 2 })).toBe(1234567.89);
  });

  test("handles plain integers", () => {
    expect(parseDecimalInput("42", { decimals: 2 })).toBe(42);
    expect(parseDecimalInput("0", { decimals: 2 })).toBe(0);
  });

  test("handles negatives", () => {
    expect(parseDecimalInput("-71,48", { decimals: 2 })).toBe(-71.48);
    expect(parseDecimalInput("-1.234,56", { decimals: 2 })).toBe(-1234.56);
    expect(parseDecimalInput("-5", { decimals: 2 })).toBe(-5);
  });

  test("copes with a leading or trailing separator", () => {
    expect(parseDecimalInput(",5", { decimals: 2 })).toBe(0.5);
    expect(parseDecimalInput(".5", { decimals: 2 })).toBe(0.5);
    expect(parseDecimalInput("5,", { decimals: 2 })).toBe(5);
    expect(parseDecimalInput("5.", { decimals: 2 })).toBe(5);
  });

  test("strips currency symbols and spaces from pasted values", () => {
    expect(parseDecimalInput("€ 71,48", { decimals: 2 })).toBe(71.48);
    expect(parseDecimalInput("1 234,56", { decimals: 2 })).toBe(1234.56);
    expect(parseDecimalInput("71,48 EUR", { decimals: 2 })).toBe(71.48);
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
    expect(parseDecimalInput("1,2345", { decimals: 2 })).toBe(1.2345);
  });
});

describe("parseDecimalInput — the ambiguous '1.234'", () => {
  test("the language settles it: a dot is grouping in German", () => {
    expect(parseDecimalInput("1.234", { decimalSeparator: "," })).toBe(1234);
    expect(parseDecimalInput("1,234", { decimalSeparator: "," })).toBe(1.234);
  });

  test("and the other way round in English", () => {
    expect(parseDecimalInput("1.234", { decimalSeparator: "." })).toBe(1.234);
    expect(parseDecimalInput("1,234", { decimalSeparator: "." })).toBe(1234);
  });

  test("without a language it falls back to what the field allows", () => {
    expect(parseDecimalInput("1.234", { decimals: 2 })).toBe(1234);
    expect(parseDecimalInput("1.234", { decimals: 3 })).toBe(1.234);
    expect(parseDecimalInput("1.234", {})).toBe(1.234);
  });

  test("an unambiguous value is unaffected by the language", () => {
    for (const separator of [",", "."] as const) {
      expect(parseDecimalInput("1.234,56", { decimalSeparator: separator })).toBe(1234.56);
      expect(parseDecimalInput("71,48", { decimalSeparator: separator })).toBe(71.48);
      expect(parseDecimalInput("1.2345", { decimalSeparator: separator })).toBe(1.2345);
    }
  });
});

describe("decimalSeparatorFor", () => {
  test("knows the convention of every language the app ships", () => {
    expect(decimalSeparatorFor("en")).toBe(".");
    expect(decimalSeparatorFor("de")).toBe(",");
    expect(decimalSeparatorFor("es")).toBe(",");
    expect(decimalSeparatorFor("fr")).toBe(",");
    expect(decimalSeparatorFor("tr")).toBe(",");
  });
});

describe("formatForDisplay", () => {
  test("writes the number the way the language does", () => {
    expect(formatForDisplay(71.48, 2, "de")).toBe("71,48");
    expect(formatForDisplay(71.48, 2, "en")).toBe("71.48");
    expect(formatForDisplay(71.48, 2, "fr")).toBe("71,48");
  });

  test("pads to the field's decimal places", () => {
    expect(formatForDisplay(5, 2, "de")).toBe("5,00");
    expect(formatForDisplay(5, 0, "de")).toBe("5");
  });

  test("does not group, so editing the field stays predictable", () => {
    expect(formatForDisplay(1234567.89, 2, "de")).toBe("1234567,89");
    expect(formatForDisplay(1234567.89, 2, "en")).toBe("1234567.89");
  });

  test("keeps precision when the field sets no decimal limit", () => {
    // Intl defaults to 3 fraction digits; an exchange rate would lose digits.
    expect(formatForDisplay(0.12345, undefined, "en")).toBe("0.12345");
  });

  test("renders nothing for empty or unparseable values", () => {
    expect(formatForDisplay(null, 2, "de")).toBe("");
    expect(formatForDisplay(undefined, 2, "de")).toBe("");
    expect(formatForDisplay("", 2, "de")).toBe("");
    expect(formatForDisplay("abc", 2, "de")).toBe("");
  });

  test("round-trips with the parser in every shipped language", () => {
    for (const [language, separator] of [
      ["de", ","],
      ["en", "."],
      ["fr", ","],
      ["es", ","],
      ["tr", ","],
    ] as const) {
      const shown = formatForDisplay(1234.56, 2, language);
      expect(parseDecimalInput(shown, { decimals: 2, decimalSeparator: separator })).toBe(1234.56);
    }
  });
});
