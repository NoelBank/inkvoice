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
const CREDIT_NOTE_NUMBER_PATTERN = "CN-{YYYY}-{SEQ4}";

function renderPattern(pattern: string, nextSequence: (prefix: string) => number): string {
  const now = new Date();

  let result = pattern;
  result = result.replace("{YYYY}", String(now.getFullYear()));
  result = result.replace("{YY}", String(now.getFullYear()).slice(-2));
  result = result.replace("{MM}", String(now.getMonth() + 1).padStart(2, "0"));
  result = result.replace("{DD}", String(now.getDate()).padStart(2, "0"));

  // Random tokens
  result = result.replace("{RAND4}", String(Math.floor(Math.random() * 10000)).padStart(4, "0"));

  // Sequence tokens. The lookup prefix comes from the rendered text, not the
  // raw pattern: every token left of {SEQ} is already substituted here, so a
  // pattern like "AN-{RAND4}-{SEQ4}" looks its sequence up against the number
  // it is actually about to produce instead of the literal "AN-{RAND4}-".
  const seqMatch = result.match(/\{SEQ(\d*)\}/);
  if (seqMatch) {
    const padLen = seqMatch[1] ? parseInt(seqMatch[1], 10) : 0;
    const nextSeq = nextSequence(result.slice(0, seqMatch.index));
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
  return renderPattern(CREDIT_NOTE_NUMBER_PATTERN, getNextSequenceNumber);
}

export function generateQuoteNumber(): string {
  return renderPattern(
    getSetting("quote_number_pattern") || DEFAULT_QUOTE_NUMBER_PATTERN,
    getNextQuoteSequenceNumber,
  );
}

// Both lookups take the already-rendered prefix (everything left of {SEQ}) and
// continue from the highest existing number sharing it, so the sequence resets
// whenever the prefix changes (a new year, month, or day).
function getNextSequenceNumber(prefix: string): number {
  const row = getDb()
    .query(
      "SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1",
    )
    .get(`${prefix}%`) as { invoice_number: string } | null;

  if (!row) return 1;

  // Extract the numeric part after the prefix
  const num = parseInt(row.invoice_number.substring(prefix.length), 10);
  return Number.isNaN(num) ? 1 : num + 1;
}

function getNextQuoteSequenceNumber(prefix: string): number {
  const row = getDb()
    .query(
      "SELECT quote_number FROM quotes WHERE quote_number LIKE ? ORDER BY quote_number DESC LIMIT 1",
    )
    .get(`${prefix}%`) as { quote_number: string } | null;

  if (!row) return 1;

  const num = parseInt(row.quote_number.substring(prefix.length), 10);
  return Number.isNaN(num) ? 1 : num + 1;
}
