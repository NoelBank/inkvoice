import { describe, expect, test } from "bun:test";
import {
  invoiceLabel,
  languageOf,
  paypalLocale,
  stripeLocale,
} from "../services/payment-gateways/strings";

describe("languageOf", () => {
  test("takes the language subtag, case-insensitively", () => {
    expect(languageOf("de-DE")).toBe("de");
    expect(languageOf("DE")).toBe("de");
    expect(languageOf("pt-BR")).toBe("pt");
  });

  test("survives null and empty input", () => {
    expect(languageOf(null)).toBe("");
    expect(languageOf(undefined)).toBe("");
    expect(languageOf("")).toBe("");
  });
});

describe("invoiceLabel", () => {
  test("translates the word, keeps the number verbatim", () => {
    expect(invoiceLabel("de-DE", "INV-2026-0001")).toBe("Rechnung INV-2026-0001");
    expect(invoiceLabel("fr", "2026/17")).toBe("Facture 2026/17");
    expect(invoiceLabel("es-MX", "A-1")).toBe("Factura A-1");
    expect(invoiceLabel("tr-TR", "F1")).toBe("Fatura F1");
  });

  test("falls back to English for languages we have no wording for", () => {
    expect(invoiceLabel("ja-JP", "INV-1")).toBe("Invoice INV-1");
    expect(invoiceLabel(null, "INV-1")).toBe("Invoice INV-1");
  });
});

describe("stripeLocale", () => {
  test("pins the checkout page to a language we can also word", () => {
    expect(stripeLocale("de-DE")).toBe("de");
    expect(stripeLocale("fr")).toBe("fr");
  });

  test("leaves Stripe's own detection alone otherwise", () => {
    expect(stripeLocale("ja-JP")).toBe("auto");
    expect(stripeLocale(null)).toBe("auto");
  });
});

describe("paypalLocale", () => {
  test("keeps an explicit region", () => {
    expect(paypalLocale("de-AT")).toBe("de-AT");
    expect(paypalLocale("es-mx")).toBe("es-MX");
  });

  test("fills in a default region for a bare language", () => {
    expect(paypalLocale("de")).toBe("de-DE");
    expect(paypalLocale("en")).toBe("en-US");
  });

  test("returns undefined rather than guessing for unknown languages", () => {
    expect(paypalLocale("ja-JP")).toBeUndefined();
    expect(paypalLocale(null)).toBeUndefined();
  });
});
