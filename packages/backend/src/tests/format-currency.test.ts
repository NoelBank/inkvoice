import { describe, expect, test } from "bun:test";
import { formatCurrency } from "../utils/currency";

describe("formatCurrency", () => {
  test("formats well-formed currency codes", () => {
    expect(formatCurrency(12.5, "EUR", "1.000,00")).toContain("12,50");
    expect(formatCurrency(12.5, "USD")).toContain("12.50");
  });

  test("falls back instead of throwing on a malformed code", () => {
    expect(formatCurrency(12.5, "E")).toBe("12.50 E");
    expect(formatCurrency(12.5, "EU")).toBe("12.50 EU");
    expect(formatCurrency(12.5, "")).toBe("12.50");
  });

  test("falls back instead of throwing on a malformed locale", () => {
    expect(formatCurrency(12.5, "EUR", undefined, "de_DE")).toBe("12.50 EUR");
  });
});
