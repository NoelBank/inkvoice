import { describe, expect, test } from "bun:test";
import { buildEpcPayload, isSepaIban, normalizeIban } from "../utils/epc-qr";
import { encodeQR } from "../utils/qr-code";

const VALID: Parameters<typeof buildEpcPayload>[0] = {
  name: "Müller & Söhne GmbH",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  amount: 1234.5,
  currency: "EUR",
  remittance: "Invoice 2026-0042",
};

describe("normalizeIban", () => {
  test("strips spaces and uppercases", () => {
    expect(normalizeIban(" de89 3704 0044 0532 0130 00 ")).toBe("DE89370400440532013000");
  });
});

describe("isSepaIban", () => {
  test("accepts a valid German IBAN", () => {
    expect(isSepaIban("DE89370400440532013000")).toBe(true);
  });

  test("accepts a valid French IBAN", () => {
    expect(isSepaIban("FR1420041010050500013M02606")).toBe(true);
  });

  test("rejects an IBAN with a broken check digit", () => {
    expect(isSepaIban("DE88370400440532013000")).toBe(false);
  });

  test("rejects an IBAN whose length is wrong for its country", () => {
    // Both pass mod-97, but Germany requires exactly 22 characters, so only the
    // per-country length check can catch them.
    expect(isSepaIban("DE6437040044053201")).toBe(false);
    expect(isSepaIban("DE783704004405320130001234")).toBe(false);
  });

  test("rejects a non-SEPA country", () => {
    // Structurally valid Turkish IBAN, but TR is outside the SEPA scheme.
    expect(isSepaIban("TR330006100519786457841326")).toBe(false);
  });

  test("rejects junk", () => {
    expect(isSepaIban("")).toBe(false);
    expect(isSepaIban("NOT AN IBAN")).toBe(false);
  });
});

describe("buildEpcPayload", () => {
  test("builds a canonical EPC 002 payload", () => {
    expect(buildEpcPayload(VALID)).toBe(
      [
        "BCD",
        "002",
        "1",
        "SCT",
        "COBADEFFXXX",
        "Müller & Söhne GmbH",
        "DE89370400440532013000",
        "EUR1234.50",
        "",
        "",
        "Invoice 2026-0042",
      ].join("\n"),
    );
  });

  test("omits the BIC when none is configured", () => {
    const lines = buildEpcPayload({ ...VALID, bic: undefined }).split("\n");
    expect(lines[4]).toBe("");
    expect(lines[6]).toBe("DE89370400440532013000");
  });

  test("normalizes a spaced, lowercase IBAN", () => {
    const lines = buildEpcPayload({ ...VALID, iban: "de89 3704 0044 0532 0130 00" }).split("\n");
    expect(lines[6]).toBe("DE89370400440532013000");
  });

  test("always formats the amount with two decimals", () => {
    expect(buildEpcPayload({ ...VALID, amount: 40 }).split("\n")[7]).toBe("EUR40.00");
    expect(buildEpcPayload({ ...VALID, amount: 0.01 }).split("\n")[7]).toBe("EUR0.01");
    expect(buildEpcPayload({ ...VALID, amount: 1234.567 }).split("\n")[7]).toBe("EUR1234.57");
  });

  test("rejects a non-EUR currency", () => {
    expect(() => buildEpcPayload({ ...VALID, currency: "USD" })).toThrow(/EUR/);
  });

  test("rejects an amount outside the SEPA range", () => {
    expect(() => buildEpcPayload({ ...VALID, amount: 0 })).toThrow(/amount/i);
    expect(() => buildEpcPayload({ ...VALID, amount: -5 })).toThrow(/amount/i);
    expect(() => buildEpcPayload({ ...VALID, amount: 1_000_000_000 })).toThrow(/amount/i);
  });

  test("rejects an invalid IBAN", () => {
    expect(() => buildEpcPayload({ ...VALID, iban: "DE88370400440532013000" })).toThrow(/IBAN/);
  });

  test("rejects an invalid BIC", () => {
    expect(() => buildEpcPayload({ ...VALID, bic: "NOPE" })).toThrow(/BIC/);
  });

  test("requires a beneficiary name", () => {
    expect(() => buildEpcPayload({ ...VALID, name: "   " })).toThrow(/name/i);
  });

  test("truncates the beneficiary name to the SEPA limit of 70", () => {
    const lines = buildEpcPayload({ ...VALID, name: "A".repeat(90) }).split("\n");
    expect(lines[5]).toBe("A".repeat(70));
  });

  test("truncates remittance text to 140 characters", () => {
    const lines = buildEpcPayload({ ...VALID, remittance: "B".repeat(200) }).split("\n");
    expect(lines[10]).toBe("B".repeat(140));
  });

  test("strips newlines so free text cannot forge payload lines", () => {
    const lines = buildEpcPayload({
      ...VALID,
      name: "Evil\nEUR9999.00",
      remittance: "ref\r\nwith breaks",
    }).split("\n");
    expect(lines[5]).toBe("Evil EUR9999.00");
    expect(lines[10]).toBe("ref with breaks");
  });

  test("drops trailing empty lines when there is no remittance", () => {
    const payload = buildEpcPayload({ ...VALID, remittance: undefined });
    expect(payload.endsWith("EUR1234.50")).toBe(true);
  });

  test("shortens remittance text to keep the payload within the 331-byte ceiling", () => {
    // A 70-character name of 2-byte characters costs 140 bytes on its own, so
    // the full 140-character remittance cannot also fit.
    const payload = buildEpcPayload({
      name: "Ä".repeat(70),
      iban: "MT84MALT011000012345MTLCAST001S",
      bic: "COBADEFFXXX",
      amount: 999_999_999.99,
      currency: "EUR",
      remittance: "C".repeat(140),
    });
    const lines = payload.split("\n");
    expect(Buffer.byteLength(payload, "utf-8")).toBeLessThanOrEqual(331);
    expect(lines[10].length).toBeGreaterThan(0);
    expect(lines[10].length).toBeLessThan(140);
    expect(() => encodeQR(payload)).not.toThrow();
  });

  test("encodes a realistic invoice payload well inside the ceiling", () => {
    const payload = buildEpcPayload(VALID);
    expect(Buffer.byteLength(payload, "utf-8")).toBeLessThanOrEqual(331);
    expect(() => encodeQR(payload)).not.toThrow();
  });

  test("throws when the mandatory fields alone exceed the ceiling", () => {
    expect(() =>
      buildEpcPayload({
        // 70 four-byte characters: 280 bytes of name before anything else.
        name: "😀".repeat(70),
        iban: "MT84MALT011000012345MTLCAST001S",
        bic: "COBADEFFXXX",
        amount: 999_999_999.99,
        currency: "EUR",
      }),
    ).toThrow(/331/);
  });
});
