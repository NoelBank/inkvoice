import { getDb } from "../database/connection";
import { buildCsv, type CsvColumn } from "../utils/csv";
import { buildZip, type ZipEntry } from "../utils/zip";
import { readAttachment } from "./attachment.service";

/**
 * Bundles one financial year into a single archive: every expense and invoice
 * as a CSV row, plus the actual receipt files, cross-referenced by name.
 *
 * This is the artefact you hand to an accountant or keep for a tax audit. It
 * is deliberately self-describing — the CSVs name the exact files in
 * `receipts/`, so the archive can be read years later without this app.
 */

export interface ArchiveExpense {
  id: string;
  expense_date: string;
  vendor: string | null;
  category: string | null;
  description: string | null;
  amount: number;
  tax_amount: number;
  total: number;
  currency: string;
  customer_name: string | null;
  receipt_files: string;
}

export interface ArchiveInvoice {
  id: string;
  invoice_number: string;
  issue_date: string;
  status: string;
  customer_name: string | null;
  subtotal: number;
  tax_total: number;
  total: number;
  amount_paid: number;
  currency: string;
  attachment_files: string;
}

export interface MissingReceipt {
  id: string;
  expense_date: string;
  vendor: string | null;
  description: string | null;
  total: number;
  currency: string;
}

function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Expenses in the year with nothing attached. This is the list that actually
 * saves the day in January — the app knows the numbers, so it can say which
 * ones have no paperwork behind them.
 */
export function findMissingReceipts(year: number): MissingReceipt[] {
  const { from, to } = yearRange(year);
  return getDb()
    .query(
      `SELECT e.id, e.expense_date, e.vendor, e.description, e.total, e.currency
         FROM expenses e
        WHERE e.expense_date BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM attachments a
             WHERE a.entity_type = 'expense' AND a.entity_id = e.id AND a.deleted_at IS NULL
          )
        ORDER BY e.expense_date`,
    )
    .all(from, to) as MissingReceipt[];
}

interface AttachmentRow {
  id: string;
  entity_id: string;
  file_name: string;
  sha256: string;
  content_type: string | null;
  bytes: number;
}

function attachmentsForYear(
  entityType: "expense" | "invoice",
  year: number,
): Map<string, AttachmentRow[]> {
  const { from, to } = yearRange(year);
  const dateColumn = entityType === "expense" ? "e.expense_date" : "e.issue_date";
  const table = entityType === "expense" ? "expenses" : "invoices";

  const rows = getDb()
    .query(
      `SELECT a.id, a.entity_id, a.file_name, a.sha256, a.content_type, a.bytes
         FROM attachments a
         JOIN ${table} e ON e.id = a.entity_id
        WHERE a.entity_type = ? AND a.deleted_at IS NULL AND ${dateColumn} BETWEEN ? AND ?
        ORDER BY a.created_at`,
    )
    .all(entityType, from, to) as AttachmentRow[];

  const byEntity = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entity_id) ?? [];
    list.push(row);
    byEntity.set(row.entity_id, list);
  }
  return byEntity;
}

/**
 * Archive file name for an attachment. Prefixed with the record's date so the
 * directory sorts chronologically, and suffixed with a counter so two files
 * on the same record can't collide.
 */
function archiveFileName(date: string, index: number, attachment: AttachmentRow): string {
  return `${date}_${String(index + 1).padStart(2, "0")}_${attachment.file_name}`;
}

const EXPENSE_COLUMNS: CsvColumn<ArchiveExpense>[] = [
  { header: "Date", key: "expense_date" },
  { header: "Vendor", key: "vendor" },
  { header: "Category", key: "category" },
  { header: "Description", key: "description" },
  { header: "Net", key: "amount" },
  { header: "Tax", key: "tax_amount" },
  { header: "Gross", key: "total" },
  { header: "Currency", key: "currency" },
  { header: "Billed to", key: "customer_name" },
  { header: "Receipt files", key: "receipt_files" },
  { header: "ID", key: "id" },
];

const INVOICE_COLUMNS: CsvColumn<ArchiveInvoice>[] = [
  { header: "Number", key: "invoice_number" },
  { header: "Date", key: "issue_date" },
  { header: "Status", key: "status" },
  { header: "Customer", key: "customer_name" },
  { header: "Net", key: "subtotal" },
  { header: "Tax", key: "tax_total" },
  { header: "Gross", key: "total" },
  { header: "Paid", key: "amount_paid" },
  { header: "Currency", key: "currency" },
  { header: "Attached files", key: "attachment_files" },
  { header: "ID", key: "id" },
];

export interface YearArchive {
  zip: Uint8Array;
  fileName: string;
  stats: {
    expenses: number;
    invoices: number;
    files: number;
    missing_receipts: number;
    /** Attachments whose blob was gone from disk; listed in the manifest. */
    unreadable_files: number;
  };
}

export function buildYearArchive(year: number): YearArchive {
  const db = getDb();
  const { from, to } = yearRange(year);

  const expenseAttachments = attachmentsForYear("expense", year);
  const invoiceAttachments = attachmentsForYear("invoice", year);

  const entries: ZipEntry[] = [];
  const unreadable: string[] = [];
  let fileCount = 0;

  /** Copies an attachment into the archive and returns its archive name. */
  const addFile = (folder: string, date: string, index: number, row: AttachmentRow): string => {
    const name = archiveFileName(date, index, row);
    const data = readAttachment({
      id: row.id,
      entity_type: folder === "receipts" ? "expense" : "invoice",
      entity_id: row.entity_id,
      file_name: row.file_name,
      content_type: row.content_type,
      bytes: row.bytes,
      sha256: row.sha256,
      uploaded_by: null,
      created_at: "",
    });

    if (!data) {
      // Never silently drop a file: the manifest has to admit the gap, or the
      // archive would look complete when it isn't.
      unreadable.push(`${folder}/${name}`);
      return `MISSING:${name}`;
    }

    entries.push({ name: `${folder}/${name}`, data });
    fileCount++;
    return name;
  };

  const expenses = db
    .query(
      `SELECT e.id, e.expense_date, e.vendor, e.category, e.description, e.amount,
              e.tax_amount, e.total, e.currency, c.name as customer_name
         FROM expenses e
         LEFT JOIN customers c ON c.id = e.customer_id
        WHERE e.expense_date BETWEEN ? AND ?
        ORDER BY e.expense_date, e.id`,
    )
    .all(from, to) as Omit<ArchiveExpense, "receipt_files">[];

  const expenseRows: ArchiveExpense[] = expenses.map((expense) => ({
    ...expense,
    receipt_files: (expenseAttachments.get(expense.id) ?? [])
      .map((row, i) => addFile("receipts", expense.expense_date, i, row))
      .join(" | "),
  }));

  const invoices = db
    .query(
      `SELECT i.id, i.invoice_number, i.issue_date, i.status, i.subtotal, i.tax_total,
              i.total, i.amount_paid, i.currency, c.name as customer_name
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.issue_date BETWEEN ? AND ? AND i.deleted_at IS NULL
        ORDER BY i.issue_date, i.invoice_number`,
    )
    .all(from, to) as Omit<ArchiveInvoice, "attachment_files">[];

  const invoiceRows: ArchiveInvoice[] = invoices.map((invoice) => ({
    ...invoice,
    attachment_files: (invoiceAttachments.get(invoice.id) ?? [])
      .map((row, i) => addFile("invoices", invoice.issue_date, i, row))
      .join(" | "),
  }));

  const missing = findMissingReceipts(year);

  entries.push({ name: "expenses.csv", data: buildCsv(expenseRows, EXPENSE_COLUMNS) });
  entries.push({ name: "invoices.csv", data: buildCsv(invoiceRows, INVOICE_COLUMNS) });
  entries.push({
    name: "manifest.txt",
    data: buildManifest({ year, expenseRows, invoiceRows, missing, fileCount, unreadable }),
  });

  return {
    zip: buildZip(entries),
    fileName: `inkvoice-${year}.zip`,
    stats: {
      expenses: expenseRows.length,
      invoices: invoiceRows.length,
      files: fileCount,
      missing_receipts: missing.length,
      unreadable_files: unreadable.length,
    },
  };
}

function buildManifest(params: {
  year: number;
  expenseRows: ArchiveExpense[];
  invoiceRows: ArchiveInvoice[];
  missing: MissingReceipt[];
  fileCount: number;
  unreadable: string[];
}): string {
  const lines = [
    `Inkvoice archive for ${params.year}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Contents",
    "  expenses.csv  — every expense dated in this year",
    "  invoices.csv  — every invoice issued in this year",
    "  receipts/     — files attached to those expenses",
    "  invoices/     — files attached to those invoices",
    "",
    `Expenses: ${params.expenseRows.length}`,
    `Invoices: ${params.invoiceRows.length}`,
    `Files: ${params.fileCount}`,
    "",
  ];

  if (params.missing.length > 0) {
    lines.push(
      `WARNING: ${params.missing.length} expense(s) in this year have no receipt attached:`,
      ...params.missing.map(
        (m) =>
          `  ${m.expense_date}  ${m.total} ${m.currency}  ${m.vendor ?? m.description ?? m.id}`,
      ),
      "",
    );
  }

  if (params.unreadable.length > 0) {
    lines.push(
      `WARNING: ${params.unreadable.length} file(s) are recorded but their contents could not be read`,
      "and are NOT included in this archive:",
      ...params.unreadable.map((name) => `  ${name}`),
      "",
    );
  }

  return lines.join("\n");
}
