/**
 * EU VAT identification numbers (USt-IdNr / VAT number). Syntax only — the
 * per-country patterns below are the published formats, and catching a typo
 * locally saves a round-trip to VIES and gives a clearer error.
 */

/** Country code → pattern for the part *after* the country code. */
const PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-IW]?|\d[A-Z*+]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  // Northern Ireland keeps an EU-checkable number under the XI prefix.
  XI: /^(\d{9}|\d{12}|(GD|HA)\d{3})$/,
};

export interface ParsedVatId {
  /** Uppercased, stripped of spaces, dots and hyphens. */
  normalized: string;
  countryCode: string;
  number: string;
  /** False when the country is unknown or the number doesn't fit its pattern. */
  syntaxValid: boolean;
}

export function normalizeVatId(input: string): string {
  return input.toUpperCase().replace(/[\s.\-/]/g, "");
}

export function parseVatId(input: string): ParsedVatId {
  const normalized = normalizeVatId(input);
  const countryCode = normalized.slice(0, 2);
  const number = normalized.slice(2);
  const pattern = PATTERNS[countryCode];

  return {
    normalized,
    countryCode,
    number,
    syntaxValid: !!pattern && pattern.test(number),
  };
}

/** True for country codes VIES can be asked about. */
export function isEuVatCountry(countryCode: string): boolean {
  return countryCode.toUpperCase() in PATTERNS;
}
