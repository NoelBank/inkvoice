/**
 * EPC QR code payloads ("GiroCode" / SEPA Credit Transfer QR).
 *
 * Encodes the payment details of an invoice into the text format defined by
 * EPC069-12, which European banking apps scan to pre-fill a SEPA transfer.
 * The result is a plain string; rendering it is the QR encoder's job.
 *
 * Layout (version 002, LF-separated):
 *   1  service tag           "BCD"
 *   2  version               "002" (BIC optional; "001" would require it)
 *   3  character set         "1" = UTF-8
 *   4  identification        "SCT"
 *   5  BIC                   optional
 *   6  beneficiary name      ≤ 70
 *   7  IBAN                  ≤ 34
 *   8  amount                "EUR" + 0.01 … 999999999.99
 *   9  purpose code          optional, unused here
 *   10 structured reference  optional, mutually exclusive with line 11
 *   11 remittance text       optional, ≤ 140
 *   12 beneficiary note      optional, unused here
 */

/** The whole payload must fit this, per EPC069-12. Matches QR version 13-M exactly. */
const MAX_PAYLOAD_BYTES = 331;
const MAX_NAME_CHARS = 70;
const MAX_REMITTANCE_CHARS = 140;
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 999_999_999.99;

/**
 * IBAN lengths for countries in the SEPA scheme (EPC409-09). Used both as the
 * membership test and as a structural check — mod-97 alone accepts IBANs of the
 * wrong length for their country.
 */
const SEPA_IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GG: 22,
  GI: 23,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IM: 22,
  IS: 26,
  IT: 27,
  JE: 22,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  VA: 22,
};

/** ISO 9362: 6 letters, 2 alphanumerics, optional 3-character branch code. */
const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Uppercase and strip spaces, the way BICs are written on paper. */
export function normalizeBic(bic: string): string {
  return bic.replace(/\s+/g, "").toUpperCase();
}

export function isValidBic(bic: string): boolean {
  return BIC_PATTERN.test(normalizeBic(bic));
}

export interface EpcPayloadInput {
  /** Account holder. Truncated to 70 characters, as SEPA itself does. */
  name: string;
  iban: string;
  bic?: string;
  /** In euros. */
  amount: number;
  /** Must be EUR — the EPC scheme is euro-only. */
  currency: string;
  /** Unstructured remittance information, e.g. "Invoice 2026-0042". */
  remittance?: string;
}

/** Uppercase and strip the spaces humans use when writing IBANs. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/** mod-97-10 check per ISO 7064. */
function ibanChecksumValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    // Letters expand to two digits (A = 10 … Z = 35), digits to one.
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : char;
    for (const digit of chunk) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * True when `iban` is well-formed, passes mod-97, and belongs to a SEPA country.
 * Anything else cannot be paid by an EPC QR code.
 */
export function isSepaIban(iban: string): boolean {
  const normalized = normalizeIban(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(normalized)) return false;
  const expectedLength = SEPA_IBAN_LENGTHS[normalized.slice(0, 2)];
  if (expectedLength === undefined || normalized.length !== expectedLength) return false;
  return ibanChecksumValid(normalized);
}

/** Collapse anything that would forge a new payload line into a single space. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return [...value].slice(0, maxChars).join("");
}

/** Shorten to fit a byte budget without splitting a multi-byte character. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const chars = [...value];
  let bytes = 0;
  let end = 0;
  while (end < chars.length) {
    const next = Buffer.byteLength(chars[end], "utf-8");
    if (bytes + next > maxBytes) break;
    bytes += next;
    end++;
  }
  return chars.slice(0, end).join("");
}

/**
 * Build the EPC payload for an invoice.
 *
 * Throws when the payment could not be made from the resulting code — a
 * non-euro invoice, a broken or non-SEPA IBAN, an out-of-range amount — so
 * callers can fall back to printing no QR code rather than a code that sends
 * money to the wrong place.
 */
export function buildEpcPayload(input: EpcPayloadInput): string {
  if (input.currency.toUpperCase() !== "EUR") {
    throw new Error(`EPC QR codes only support EUR, got ${input.currency}`);
  }

  const name = truncate(singleLine(input.name), MAX_NAME_CHARS);
  if (!name) throw new Error("EPC QR codes require a beneficiary name");

  const iban = normalizeIban(input.iban);
  if (!isSepaIban(iban)) {
    throw new Error(`Not a valid SEPA IBAN: ${input.iban}`);
  }

  const bic = normalizeBic(input.bic || "");
  if (bic && !BIC_PATTERN.test(bic)) {
    throw new Error(`Not a valid BIC: ${input.bic}`);
  }

  if (!Number.isFinite(input.amount) || input.amount < MIN_AMOUNT || input.amount > MAX_AMOUNT) {
    throw new Error(
      `EPC QR amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} EUR, got ${input.amount}`,
    );
  }
  const amount = `EUR${input.amount.toFixed(2)}`;

  const head = ["BCD", "002", "1", "SCT", bic, name, iban, amount];
  const headBytes = Buffer.byteLength(head.join("\n"), "utf-8");
  if (headBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `EPC payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${headBytes}) before remittance information`,
    );
  }

  const remittance = truncate(singleLine(input.remittance || ""), MAX_REMITTANCE_CHARS);
  if (!remittance) return head.join("\n");

  // Lines 9 (purpose) and 10 (structured reference) stay empty; the remittance
  // goes in line 11. Three extra separators precede it.
  const budget = MAX_PAYLOAD_BYTES - headBytes - 3;
  const fitted = truncateToBytes(remittance, Math.max(0, budget));
  if (!fitted) return head.join("\n");

  return [...head, "", "", fitted].join("\n");
}
