import crypto from "node:crypto";

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30-second step) — the algorithm every
 * authenticator app implements. Written by hand rather than pulled in as a
 * dependency: it is ~80 lines and Bun ships the crypto primitives.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Tolerates lowercase, spaces and `=` padding — users retype these by hand. */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 20 bytes = 160 bits, the shared-secret size RFC 4226 recommends for SHA-1. */
export function generateSecret(byteLength = 20): string {
  return base32Encode(crypto.randomBytes(byteLength));
}

export function counterForTime(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** RFC 4226 HOTP: HMAC-SHA1 over the big-endian counter, dynamically truncated. */
export function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface VerifyResult {
  valid: boolean;
  /** Counter the code matched, so the caller can reject replays of it. */
  counter: number | null;
}

/**
 * Accepts codes from `window` steps either side of now, absorbing clock drift
 * between the server and the phone. The matched counter is returned so callers
 * can persist it and refuse the same code a second time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { window?: number; nowMs?: number } = {},
): VerifyResult {
  const window = opts.window ?? 1;
  const trimmed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(trimmed)) return { valid: false, counter: null };

  const current = counterForTime(opts.nowMs);
  for (let drift = -window; drift <= window; drift++) {
    const counter = current + drift;
    if (counter < 0) continue;
    if (timingSafeEqualStrings(totpCode(secret, counter), trimmed)) {
      return { valid: true, counter };
    }
  }
  return { valid: false, counter: null };
}

/** otpauth:// URI — what the QR code encodes for authenticator apps. */
export function buildOtpauthUri(params: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
