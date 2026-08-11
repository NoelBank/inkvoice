import crypto from "node:crypto";
import { getDb } from "../database/connection";
import { getSetting } from "../services/settings.service";

export function generateDraftNumber(): string {
  return `DRAFT-${crypto.randomBytes(3).toString("hex")}`;
}

export function isDraftNumber(invoiceNumber: string): boolean {
  return invoiceNumber.startsWith("DRAFT-");
}

const DEFAULT_INVOICE_NUMBER_PATTERN = "INV-{YYYY}-{SEQ4}";
const DEFAULT_QUOTE_NUMBER_PATTERN = "QT-{YYYY}-{SEQ4}";
const DEFAULT_CREDIT_NOTE_NUMBER_PATTERN = "CN-{YYYY}-{SEQ4}";

function renderPattern(pattern: string, nextSequence: (pattern: string) => number): string {
  const now = new Date();

  let result = pattern;
  result = result.replace("{YYYY}", String(now.getFullYear()));
  result = result.replace("{YY}", String(now.getFullYear()).slice(-2));
  result = result.replace("{MM}", String(now.getMonth() + 1).padStart(2, "0"));
  result = result.replace("{DD}", String(now.getDate()).padStart(2, "0"));

  // Random tokens
  result = result.replace("{RAND4}", String(Math.floor(Math.random() * 10000)).padStart(4, "0"));

  // Sequence tokens
  const seqMatch = result.match(/\{SEQ(\d*)\}/);
  if (seqMatch) {
    const padLen = seqMatch[1] ? parseInt(seqMatch[1], 10) : 0;
    const nextSeq = nextSequence(pattern);
    const seqStr = padLen > 0 ? String(nextSeq).padStart(padLen, "0") : String(nextSeq);
    result = result.replace(seqMatch[0], seqStr);
  }

  return result;
}

export function generateInvoiceNumber(): string {
  return renderPattern(
    getSetting("invoice_number_pattern") || DEFAULT_INVOICE_NUMBER_PATTERN,
    getNextSequenceNumber,
  );
}

export function generateCreditNoteNumber(): string {
  return renderPattern(
    getSetting("credit_note_number_pattern") || DEFAULT_CREDIT_NOTE_NUMBER_PATTERN,
    getNextSequenceNumber,
  );
}

export function generateQuoteNumber(): string {
  return renderPattern(
    getSetting("quote_number_pattern") || DEFAULT_QUOTE_NUMBER_PATTERN,
    getNextQuoteSequenceNumber,
  );
}

// Build the static prefix before the sequence token, replacing other tokens
// with current values. Returns null when the pattern has no sequence token.
function sequencePrefix(pattern: string): string | null {
  const seqIndex = pattern.indexOf("{SEQ");
  if (seqIndex === -1) return null;

  const now = new Date();
  let prefix = pattern.substring(0, seqIndex);
  prefix = prefix.replace("{YYYY}", String(now.getFullYear()));
  prefix = prefix.replace("{YY}", String(now.getFullYear()).slice(-2));
  prefix = prefix.replace("{MM}", String(now.getMonth() + 1).padStart(2, "0"));
  prefix = prefix.replace("{DD}", String(now.getDate()).padStart(2, "0"));
  return prefix;
}

// Highest sequence seen among numbers sharing the prefix, plus one.
// Numbers whose remainder does not start with a digit are neighbours that only
// share the prefix (credit notes counted off the invoices table under a pattern
// nested inside the invoice prefix, say) — they carry no sequence to continue.
function nextSequenceFrom(numbers: string[], prefix: string): number {
  let highest = 0;
  for (const number of numbers) {
    const digits = number.substring(prefix.length).match(/^\d+/);
    if (!digits) continue;
    const num = parseInt(digits[0], 10);
    if (num > highest) highest = num;
  }
  return highest + 1;
}

function getNextSequenceNumber(pattern: string): number {
  const prefix = sequencePrefix(pattern);
  if (prefix === null) return 1;

  const rows = getDb()
    .query("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?")
    .all(`${prefix}%`) as { invoice_number: string }[];

  return nextSequenceFrom(
    rows.map((r) => r.invoice_number),
    prefix,
  );
}

function getNextQuoteSequenceNumber(pattern: string): number {
  const prefix = sequencePrefix(pattern);
  if (prefix === null) return 1;

  const rows = getDb()
    .query("SELECT quote_number FROM quotes WHERE quote_number LIKE ?")
    .all(`${prefix}%`) as { quote_number: string }[];

  return nextSequenceFrom(
    rows.map((r) => r.quote_number),
    prefix,
  );
}
