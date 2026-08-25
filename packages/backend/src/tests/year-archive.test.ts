import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { blobPath, storeAttachment } from "../services/attachment.service";
import { buildYearArchive, findMissingReceipts } from "../services/year-archive.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-year-archive.db";
const ATTACHMENTS_DIR = "./data/test-year-archive-blobs";
const PASSWORD = "yeararchivepass1";

let app: Hono;
let token: string;

/** Reads a stored-mode zip into { name -> bytes } without a zip library. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 4 <= zip.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(zip.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    files.set(name, zip.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return files;
}

function text(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function addExpense(id: string, date: string, vendor: string, total = 119): void {
  getDb().run(
    "INSERT INTO expenses (id, vendor, expense_date, amount, tax_amount, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, vendor, date, total / 1.19, total - total / 1.19, total, "EUR"],
  );
}

function attach(expenseId: string, fileName: string, content: string): string {
  return storeAttachment({
    entityType: "expense",
    entityId: expenseId,
    fileName,
    contentType: "application/pdf",
    data: new TextEncoder().encode(content),
    uploadedBy: null,
  }).attachment.sha256;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ATTACHMENTS_DIR = ATTACHMENTS_DIR;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = PASSWORD;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEST_DB + suffix);
    } catch {}
  }
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  token = ((await res.json()) as any).data.token;
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM expenses");
  db.run("DELETE FROM invoices");
  db.run("DELETE FROM customers");
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
});

afterAll(() => {
  closeDatabase();
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("findMissingReceipts", () => {
  test("lists exactly the expenses with nothing attached", () => {
    addExpense("with-receipt", "2026-02-01", "Hetzner");
    addExpense("without-receipt", "2026-03-01", "Deutsche Bahn");
    attach("with-receipt", "hetzner.pdf", "invoice bytes");

    const missing = findMissingReceipts(2026);
    expect(missing.map((m) => m.id)).toEqual(["without-receipt"]);
  });

  test("ignores other years", () => {
    addExpense("last-year", "2025-12-31", "Old");
    addExpense("this-year", "2026-01-01", "New");
    expect(findMissingReceipts(2026).map((m) => m.id)).toEqual(["this-year"]);
  });

  test("a soft-deleted receipt makes the expense count as missing again", () => {
    addExpense("e1", "2026-05-05", "Vendor");
    attach("e1", "receipt.pdf", "bytes");
    expect(findMissingReceipts(2026)).toHaveLength(0);

    getDb().run("UPDATE attachments SET deleted_at = datetime('now')");
    expect(findMissingReceipts(2026)).toHaveLength(1);
  });
});

describe("buildYearArchive", () => {
  test("contains the CSVs, the manifest and the receipt files", () => {
    addExpense("e1", "2026-04-02", "Hetzner");
    attach("e1", "hetzner.pdf", "receipt one");

    const archive = buildYearArchive(2026);
    const files = readZip(archive.zip);

    expect([...files.keys()]).toContain("expenses.csv");
    expect([...files.keys()]).toContain("invoices.csv");
    expect([...files.keys()]).toContain("manifest.txt");
    expect(text(files.get("receipts/2026-04-02_01_hetzner.pdf"))).toBe("receipt one");
  });

  test("the CSV names the exact file in the archive", () => {
    addExpense("e1", "2026-04-02", "Hetzner");
    attach("e1", "hetzner.pdf", "receipt one");

    const files = readZip(buildYearArchive(2026).zip);
    const csv = text(files.get("expenses.csv"));

    expect(csv).toContain("2026-04-02_01_hetzner.pdf");
    // Every file the CSV points at has to actually be in the archive.
    const referenced = csv
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(",")[9]);
    for (const name of referenced.filter(Boolean)) {
      expect([...files.keys()]).toContain(`receipts/${name}`);
    }
  });

  test("two receipts on one expense get distinct names", () => {
    addExpense("e1", "2026-04-02", "Hetzner");
    attach("e1", "page1.pdf", "first page");
    attach("e1", "page2.pdf", "second page");

    const files = readZip(buildYearArchive(2026).zip);
    expect(text(files.get("receipts/2026-04-02_01_page1.pdf"))).toBe("first page");
    expect(text(files.get("receipts/2026-04-02_02_page2.pdf"))).toBe("second page");
  });

  test("only includes records dated in the requested year", () => {
    addExpense("in-year", "2026-06-01", "In");
    addExpense("out-of-year", "2025-06-01", "Out");
    attach("in-year", "in.pdf", "in");
    attach("out-of-year", "out.pdf", "out");

    const archive = buildYearArchive(2026);
    const csv = text(readZip(archive.zip).get("expenses.csv"));

    expect(csv).toContain("In");
    expect(csv).not.toContain("Out");
    expect(archive.stats.expenses).toBe(1);
    expect(archive.stats.files).toBe(1);
  });

  test("the manifest warns about expenses with no receipt", () => {
    addExpense("no-receipt", "2026-07-07", "Taxi", 42);

    const archive = buildYearArchive(2026);
    const manifest = text(readZip(archive.zip).get("manifest.txt"));

    expect(archive.stats.missing_receipts).toBe(1);
    expect(manifest).toContain("WARNING");
    expect(manifest).toContain("2026-07-07");
    expect(manifest).toContain("Taxi");
  });

  test("a missing blob is reported instead of silently dropped", () => {
    addExpense("e1", "2026-08-08", "Vendor");
    const sha = attach("e1", "gone.pdf", "these bytes will vanish");
    rmSync(blobPath(sha));

    const archive = buildYearArchive(2026);
    const files = readZip(archive.zip);

    expect(archive.stats.unreadable_files).toBe(1);
    expect(archive.stats.files).toBe(0);
    expect(text(files.get("manifest.txt"))).toContain("could not be read");
    expect(text(files.get("expenses.csv"))).toContain("MISSING:");
  });

  test("an empty year still produces a valid archive", () => {
    const archive = buildYearArchive(2026);
    const files = readZip(archive.zip);

    expect(archive.stats).toMatchObject({ expenses: 0, invoices: 0, files: 0 });
    expect(text(files.get("expenses.csv"))).toContain("Date");
    expect(text(files.get("manifest.txt"))).toContain("Inkvoice archive for 2026");
  });

  test("includes invoices issued in the year", () => {
    getDb().run("INSERT INTO customers (id, name) VALUES ('c1', 'Kunde GmbH')");
    getDb().run(
      `INSERT INTO invoices (id, invoice_number, customer_id, status, issue_date, subtotal, tax_total, total, currency)
       VALUES ('i1', 'INV-2026-0001', 'c1', 'paid', '2026-09-09', 100, 19, 119, 'EUR')`,
    );

    const archive = buildYearArchive(2026);
    const csv = text(readZip(archive.zip).get("invoices.csv"));

    expect(archive.stats.invoices).toBe(1);
    expect(csv).toContain("INV-2026-0001");
    expect(csv).toContain("Kunde GmbH");
  });
});

describe("GET /export/year/:year", () => {
  test("downloads a zip named after the year", async () => {
    addExpense("e1", "2026-04-02", "Hetzner");
    attach("e1", "hetzner.pdf", "receipt");

    const res = await app.request("/api/v1/export/year/2026", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("inkvoice-2026.zip");

    const stats = JSON.parse(res.headers.get("x-archive-stats") ?? "{}");
    expect(stats.expenses).toBe(1);
    expect(stats.files).toBe(1);

    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    expect([...files.keys()]).toContain("receipts/2026-04-02_01_hetzner.pdf");
  });

  test("rejects a nonsensical year", async () => {
    for (const year of ["abc", "1800", "9999"]) {
      const res = await app.request(`/api/v1/export/year/${year}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    }
  });

  test("requires authentication", async () => {
    const res = await app.request("/api/v1/export/year/2026");
    expect(res.status).toBe(401);
  });

  test("the missing-receipts endpoint mirrors the manifest warning", async () => {
    addExpense("no-receipt", "2026-07-07", "Taxi", 42);

    const res = await app.request("/api/v1/export/year/2026/missing-receipts", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].vendor).toBe("Taxi");
  });
});
