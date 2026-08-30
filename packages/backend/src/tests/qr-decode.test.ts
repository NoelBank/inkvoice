import { describe, expect, test } from "bun:test";
import jsQR from "jsqr";
import { encodeQR } from "../utils/qr-code";

/**
 * Round-trip tests: the only property that actually matters for a QR code on an
 * invoice is that a real scanner can read it back. `qr-code.test.ts` checks the
 * matrix shape; these check decodability using an independent decoder (jsQR),
 * so a spec violation in format/version info can't slip through.
 */

/** Render an encoded matrix to RGBA pixels with a quiet zone, as a camera would see it. */
function renderToRgba(text: string, border = 4, scale = 4) {
  const { size, modules } = encodeQR(text);
  const dim = (size + border * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - border;
      const my = Math.floor(y / scale) - border;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my][mx];
      const i = (y * dim + x) * 4;
      const v = dark ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return { data, dim };
}

function decode(text: string): string | null {
  const { data, dim } = renderToRgba(text);
  return jsQR(data, dim, dim)?.data ?? null;
}

/** Payload of exactly `bytes` ASCII characters. */
function payloadOf(bytes: number): string {
  const prefix = "https://invoices.example.com/public/invoice/";
  return bytes <= prefix.length
    ? prefix.slice(0, bytes)
    : prefix + "a".repeat(bytes - prefix.length);
}

describe("qr-code round-trip", () => {
  test("decodes a short payload", () => {
    const payload = "HELLO";
    expect(decode(payload)).toBe(payload);
  });

  test("decodes a typical invoice share URL", () => {
    const payload = "https://invoices.example.com/public/invoice/9f8a7b6c5d4e3f21";
    expect(decode(payload)).toBe(payload);
  });

  test("decodes payloads at every version boundary up to 13", () => {
    // Byte-mode capacities at ECC level M, per ISO/IEC 18004 table 7.
    const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331];
    for (const [index, capacity] of capacities.entries()) {
      const version = index + 1;
      const payload = payloadOf(capacity);
      expect(payload.length).toBe(capacity);
      const { size } = encodeQR(payload);
      expect(size).toBe(17 + version * 4);
      expect(decode(payload)).toBe(payload);
    }
  });

  test("decodes UTF-8 payloads with multi-byte characters", () => {
    const payload = "Zahlung für Rechnung Nr. 2026-0042 — Müller & Söhne GmbH";
    expect(decode(payload)).toBe(payload);
  });

  test("rejects payloads larger than version 13 capacity", () => {
    expect(() => encodeQR(payloadOf(332))).toThrow();
  });
});
