import {
  AFRelationship,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { formatCurrency } from "../utils/currency";
import type { XmlInvoiceData } from "../xml/types";

// Lightweight A4 renderer for the ZUGFeRD hybrid PDF. It embeds the Factur-X
// CII XML as an associated file (PDF/A-3 "Alternative" relationship) while the
// visible page stays simple and dependency-free (pdf-lib, no headless Chrome).
// The app's printable HTML templates are deliberately untouched: this PDF is
// only produced per customer when e-invoice emission is enabled.
// NOTE: standard (unembedded) fonts are used for zero footprint; strict
// veraPDF runs may warn about unembedded fonts, ZUGFeRD consumers accept it.

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 50;
const WIDTH = PAGE_W - MARGIN * 2; // 495
const TABLE_X = MARGIN;
const TABLE_W = WIDTH;
const META_X = 430;

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.45, 0.45, 0.45);
const FAINT = rgb(0.6, 0.6, 0.6);

// Column x-offsets (from TABLE_X): pos, description, quantity, unit price, total
const COL_POS = 0;
const COL_DESC = 30;
const COL_QTY = 345;
const COL_PRICE = 415;
const COL_TOTAL = 468;

interface EinvoicePdfInput {
  data: XmlInvoiceData;
  /** Factur-X XML (CII) to embed as an associated file. */
  facturXml: string;
  /** Name used for the embedded file stream (default: factur-x.xml). */
  xmlFileName?: string;
  /** Name of the generated PDF (default: <invoice_number>.pdf). */
  pdfName?: string;
}

interface EinvoicePdfResult {
  pdfBytes: Uint8Array;
  pdfName: string;
}

export async function buildEinvoicePdf(input: EinvoicePdfInput): Promise<EinvoicePdfResult> {
  const { data, facturXml } = input;
  const isCredit = data.type === "credit_note";
  const currency = data.currency || "EUR";
  const locale = data.locale && data.locale.startsWith("de") ? "de-DE" : "en-US";

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${isCredit ? "Gutschrift" : "Rechnung"} ${data.invoice_number}`);
  pdf.setCreator("Inkvoice");
  pdf.setSubject(`${isCredit ? "Credit note" : "Invoice"} ${data.invoice_number}`);
  pdf.setCreationDate(new Date());

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([PAGE_W, PAGE_H]);

  let y = PAGE_H - MARGIN;

  // ---------- Seller block (left) ----------
  text(page, String(data.supplier.name || "").toUpperCase(), 13, MARGIN, y, bold, INK);
  y -= 17;
  const sellerAddr = [
    data.supplier.address,
    data.supplier.street,
    [data.supplier.postal_code, data.supplier.city].filter(Boolean).join(" "),
    data.supplier.country,
  ].filter(Boolean);
  y = lines(page, sellerAddr.join("\n"), 10, MARGIN, y, font, INK, 13);
  const contact = [
    data.supplier.email && `E-Mail: ${data.supplier.email}`,
    data.supplier.phone && `Telefon: ${data.supplier.phone}`,
  ].filter(Boolean);
  if (contact.length) y = lines(page, contact.join("\n"), 9, MARGIN, y, font, MUTED, 12);
  const taxLines = [
    data.supplier.tax_id && `USt-IdNr.: ${data.supplier.tax_id}`,
    data.supplier.tax_number && `Steuernummer: ${data.supplier.tax_number}`,
  ].filter(Boolean);
  if (taxLines.length) y = lines(page, taxLines.join("\n"), 9, MARGIN, y, font, MUTED, 12);

  // ---------- Document meta (right) ----------
  right(page, isCredit ? "GUTSCHRIFT" : "RECHNUNG", 18, META_X, PAGE_H - MARGIN, bold, INK);
  const meta: Array<[string, string]> = [
    [isCredit ? "Gutschrift-Nr." : "Rechnungs-Nr.", data.invoice_number],
    ["Datum", fmtDate(data.issue_date)],
    ...(data.due_date ? [["Fällig am", fmtDate(data.due_date)] as [string, string]] : []),
    ["Währung", currency.toUpperCase()],
  ];
  let metaY = PAGE_H - MARGIN - 28;
  for (const [label, value] of meta) {
    right(page, label, 8, META_X - 30, metaY, font, MUTED);
    right(page, value, 9, META_X, metaY, font, INK);
    metaY -= 15;
  }

  // ---------- Buyer block ----------
  const buyerLines = [
    data.customer.name,
    data.customer.address_line1,
    data.customer.address_line2,
    [data.customer.postal_code, data.customer.city].filter(Boolean).join(" "),
    data.customer.country,
  ].filter(Boolean);

  const buyerTop = Math.min(y, metaY + 15) - 26;
  lines(page, "Rechnungsempfänger", 8, MARGIN, buyerTop, font, MUTED, 11);
  lines(page, buyerLines.join("\n"), 10, MARGIN, buyerTop - 12, font, INK, 13);
  const buyerHeight = buyerLines.length * 13 + 12;

  // ---------- Line items table ----------
  let tableY = buyerTop - buyerHeight - 6;
  tableY = hline(page, tableY, true);

  tableY -= 13;
  tableHeader(page, font, tableY);
  tableY -= 15;
  tableY = hline(page, tableY, false);

  tableY -= 20;

  const items = (data.items || []).map((it, i) => ({
    no: String(i + 1),
    desc: it.description,
    qty: fmtQty(it.quantity),
    price: fmtMoney(it.unit_price, currency, locale),
    total: fmtMoney(it.line_total, currency, locale),
  }));

  for (const it of items) {
    text(page, it.no, 9, MARGIN + COL_POS, tableY, font, INK);
    const descLines = wrapText(page, it.desc, font, 9, COL_QTY - COL_DESC - 6);
    const descCount = descLines.split("\n").length;
    const rowBottom = tableY - descCount * 12;
    lines(page, descLines, 9, MARGIN + COL_DESC, tableY, font, INK, 12);
    right(page, it.qty, 9, MARGIN + COL_QTY, rowBottom, font, INK);
    right(page, it.price, 9, MARGIN + COL_PRICE, rowBottom, font, INK);
    right(page, it.total, 9, MARGIN + COL_TOTAL, rowBottom, font, INK);
    tableY = rowBottom - 8;
  }

  // ---------- Totals ----------
  const taxRows: Array<[string, string]> = data.tax_breakdown.map((tax) => [
    taxLabel(tax),
    fmtMoney(tax.tax_amount, currency, locale),
  ]);

  tableY -= 8;
  tableY = drawTotals(page, font, tableY, [
    ["Zwischensumme", fmtMoney(data.subtotal, currency, locale)],
    ...(data.discount_amount
      ? [["Rabatt", `- ${fmtMoney(data.discount_amount, currency, locale)}`] as [string, string]]
      : []),
    ...taxRows,
  ]);
  tableY = drawTotal(
    page,
    bold,
    tableY,
    isCredit ? "Gutschrift gesamt" : "Gesamtbetrag",
    fmtMoney(data.total, currency, locale),
    10,
  );

  if (data.kleinunternehmer) {
    tableY -= 6;
    tableY = lines(
      page,
      "Kleinunternehmer gemäß §19 Abs.1 UStG: keine Umsatzsteuer ausgewiesen.",
      8,
      MARGIN,
      tableY,
      font,
      MUTED,
      11,
    );
  }

  // ---------- Notes / payment terms ----------
  const notes = [
    data.payment_terms && `Zahlungsbedingungen: ${data.payment_terms}`,
    data.notes,
    data.supplier.bank_details,
  ].filter((v): v is string => !!v);
  if (notes.length) {
    tableY -= 10;
    tableY = lines(page, "Anmerkungen", 8, MARGIN, tableY, font, MUTED, 11);
    for (const n of notes) {
      tableY -= 2;
      tableY = lines(page, wrapText(page, n, font, 9, TABLE_W), 9, MARGIN, tableY, font, INK, 12);
    }
  }

  // ---------- Footer ----------
  page.drawLine({
    start: { x: MARGIN, y: 40 },
    end: { x: MARGIN + TABLE_W, y: 40 },
    thickness: 0.3,
    color: FAINT,
  });
  text(
    page,
    `E-Rechnung (${isCredit ? "Gutschrift" : "Rechnung"} · ZUGFeRD/Factur-X) mit eingebettetem XML. Gesamt ${fmtMoney(data.total, currency, locale)}`,
    7,
    MARGIN,
    28,
    font,
    MUTED,
  );

  // ---------- Embed Factur-X XML (PDF/A-3 associated file) ----------
  await pdf.attach(utf8Bytes(facturXml), input.xmlFileName || "factur-x.xml", {
    mimeType: "application/xml",
    description: `Factur-X ${isCredit ? "Gutschrift" : "Rechnung"} ${data.invoice_number}`,
    afRelationship: AFRelationship.Alternative,
  });

  return { pdfBytes: await pdf.save(), pdfName: input.pdfName || `${data.invoice_number}.pdf` };
}

// ---------- drawing helpers ----------

function text(
  page: PDFPage,
  txt: string,
  size: number,
  x: number,
  y: number,
  font: PDFFont,
  color = INK,
): void {
  page.drawText(txt, { x, y, size, font, color });
}

function right(
  page: PDFPage,
  txt: string,
  size: number,
  rightX: number,
  y: number,
  font: PDFFont,
  color = INK,
): void {
  page.drawText(txt, { x: rightX - font.widthOfTextAtSize(txt, size), y, size, font, color });
}

function lines(
  page: PDFPage,
  txt: string,
  size: number,
  x: number,
  y: number,
  font: PDFFont,
  color = INK,
  lineHeight: number,
): number {
  for (const line of txt.split("\n")) {
    page.drawText(line, { x, y, size, font, color });
    y -= lineHeight;
  }
  return y;
}

function wrapText(
  page: PDFPage,
  txt: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string {
  const out: string[] = [];
  let line = "";
  for (const word of txt.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.join("\n");
}

function hline(page: PDFPage, y: number, strong: boolean): number {
  page.drawLine({
    start: { x: TABLE_X, y },
    end: { x: TABLE_X + TABLE_W, y },
    thickness: strong ? 0.8 : 0.3,
    color: strong ? INK : FAINT,
  });
  return y;
}

function tableHeader(page: PDFPage, font: PDFFont, y: number): void {
  const cols: Array<[string, number, boolean]> = [
    ["Pos.", COL_POS, false],
    ["Beschreibung", COL_DESC, false],
    ["Menge", COL_QTY, true],
    ["Einzelpreis", COL_PRICE, true],
    ["Gesamt", COL_TOTAL, true],
  ];
  for (const [label, x, alignRight] of cols) {
    if (alignRight) right(page, label, 8, MARGIN + x, y, font, MUTED);
    else text(page, label, 8, MARGIN + x, y, font, MUTED);
  }
}

function drawTotals(
  page: PDFPage,
  font: PDFFont,
  y: number,
  rows: Array<[string, string]>,
): number {
  for (const [label, value] of rows) {
    text(page, label, 9, MARGIN + COL_QTY - 20, y, font, INK);
    right(page, value, 9, MARGIN + COL_TOTAL, y, font, INK);
    y -= 13;
  }
  return y;
}

function drawTotal(
  page: PDFPage,
  bold: PDFFont,
  y: number,
  label: string,
  value: string,
  size: number,
): number {
  text(page, label, size, MARGIN + COL_QTY - 20, y, bold, INK);
  right(page, value, size, MARGIN + COL_TOTAL, y, bold, INK);
  return y - size - 4;
}

// ---------- formatting helpers ----------

function taxLabel(tax: XmlInvoiceData["tax_breakdown"][number]): string {
  if (tax.tax_rate === 0) return `${tax.tax_name || "MwSt."} (${tax.category_code || "Z"})`;
  const rate = tax.tax_rate % 1 === 0 ? tax.tax_rate.toFixed(0) : tax.tax_rate.toFixed(2);
  return `${tax.tax_name || "Umsatzsteuer"} ${rate}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function fmtQty(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function fmtMoney(n: number, currency: string, locale: string): string {
  return formatCurrency(n, currency, undefined, locale);
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
