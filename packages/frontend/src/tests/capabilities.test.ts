import { describe, expect, test } from "bun:test";
import { deriveCapabilities } from "../lib/capabilities";

describe("deriveCapabilities", () => {
  test("default: VAT features on, small-business mode off", () => {
    expect(deriveCapabilities({})).toEqual({ smallBusiness: false, vat: true });
  });

  test("Kleinunternehmer setting switches to small-business mode without VAT", () => {
    expect(deriveCapabilities({ einvoice_kleinunternehmer: "true" })).toEqual({
      smallBusiness: true,
      vat: false,
    });
  });

  test('only the literal string "true" enables it', () => {
    expect(deriveCapabilities({ einvoice_kleinunternehmer: "1" }).smallBusiness).toBe(false);
    expect(deriveCapabilities({ einvoice_kleinunternehmer: "false" }).smallBusiness).toBe(false);
  });
});
