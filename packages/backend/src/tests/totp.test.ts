import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  counterForTime,
  generateSecret,
  totpCode,
  verifyTotp,
} from "../utils/totp";

// RFC 6238 Appendix B reference secret: ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  test("round-trips arbitrary bytes", () => {
    for (const len of [1, 2, 5, 10, 20, 32]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37) % 256);
      expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  test("tolerates lowercase, spaces and padding", () => {
    const encoded = base32Encode(Uint8Array.from([1, 2, 3, 4, 5]));
    const messy = `${encoded
      .toLowerCase()
      .match(/.{1,4}/g)
      ?.join(" ")}==`;
    expect(Array.from(base32Decode(messy))).toEqual(Array.from(base32Decode(encoded)));
  });

  test("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC!")).toThrow();
  });
});

describe("totpCode — RFC 6238 test vectors", () => {
  // The RFC lists 8-digit codes; the 6-digit variant is the same value mod 1e6.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];

  for (const [unixSeconds, expected] of vectors) {
    test(`t=${unixSeconds} → ${expected}`, () => {
      expect(totpCode(RFC_SECRET, counterForTime(unixSeconds * 1000))).toBe(expected);
    });
  }
});

describe("verifyTotp", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  test("accepts the current code and reports its counter", () => {
    const code = totpCode(secret, counterForTime(now));
    const result = verifyTotp(secret, code, { nowMs: now });
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(counterForTime(now));
  });

  test("accepts one step of drift in both directions", () => {
    const current = counterForTime(now);
    for (const drift of [-1, 1]) {
      const result = verifyTotp(secret, totpCode(secret, current + drift), { nowMs: now });
      expect(result.valid).toBe(true);
      expect(result.counter).toBe(current + drift);
    }
  });

  test("rejects drift beyond the window", () => {
    const current = counterForTime(now);
    expect(verifyTotp(secret, totpCode(secret, current + 2), { nowMs: now }).valid).toBe(false);
    expect(verifyTotp(secret, totpCode(secret, current - 2), { nowMs: now }).valid).toBe(false);
  });

  test("rejects malformed input without throwing", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(secret, bad, { nowMs: now }).valid).toBe(false);
    }
  });

  test("ignores whitespace inside an otherwise valid code", () => {
    const code = totpCode(secret, counterForTime(now));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { nowMs: now }).valid).toBe(true);
  });

  test("a code from a different secret does not verify", () => {
    const other = generateSecret();
    const code = totpCode(other, counterForTime(now));
    expect(verifyTotp(secret, code, { nowMs: now }).valid).toBe(false);
  });
});

describe("buildOtpauthUri", () => {
  test("encodes issuer, account and parameters", () => {
    const uri = buildOtpauthUri({ secret: "ABCD", account: "ada@example.com", issuer: "Inkvoice" });
    expect(uri.startsWith("otpauth://totp/Inkvoice:ada%40example.com?")).toBe(true);
    const params = new URLSearchParams(uri.split("?")[1]);
    expect(params.get("secret")).toBe("ABCD");
    expect(params.get("issuer")).toBe("Inkvoice");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });

  test("escapes an issuer containing a colon or space", () => {
    const uri = buildOtpauthUri({ secret: "ABCD", account: "a b", issuer: "Ink: Co" });
    expect(uri).toContain("Ink%3A%20Co:a%20b");
  });
});
