import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { getEuerReport } from "../services/report.service";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-euer-report.db";
let app: Hono;
let token: string;
const CUSTOMER = "cust-euer";

function insertInvoice(opts: { total: number; taxTotal: number; exchangeRate?: number }): string {
  const id = crypto.randomUUID().replaceAll("-", "");
  getDb()
    .query(
      `INSERT INTO invoices (id, invoice_number, customer_id, status, issue_date, subtotal, tax_total, total, exchange_rate)
       VALUES (?, ?, ?, 'paid', '2025-06-01', ?, ?, ?, ?)`,
    )
    .run(
      id,
      `INV-${id.slice(0, 8)}`,
      CUSTOMER,
      opts.total - opts.taxTotal,
      opts.taxTotal,
      opts.total,
      opts.exchangeRate ?? 1,
    );
  return id;
}

function insertPayment(invoiceId: string, amount: number, date: string): void {
  getDb()
    .query(`INSERT INTO payments (invoice_id, amount, payment_date) VALUES (?, ?, ?)`)
    .run(invoiceId, amount, date);
}

function insertExpense(opts: {
  category: string | null;
  amount: number;
  taxAmount: number;
  date: string;
}): void {
  getDb()
    .query(
      `INSERT INTO expenses (category, expense_date, amount, tax_amount, total, exchange_rate)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(opts.category, opts.date, opts.amount, opts.taxAmount, opts.amount + opts.taxAmount);
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();
  getDb().query(`INSERT INTO customers (id, name) VALUES (?, 'EÜR GmbH')`).run(CUSTOMER);

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "testpass123" }),
  });
  token = (await res.json()).data.token;
});

afterAll(() => {
  closeDatabase();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

beforeEach(() => {
  const db = getDb();
  db.query("DELETE FROM payments").run();
  db.query("DELETE FROM expenses").run();
  db.query("DELETE FROM invoices").run();
  updateSettings({ einvoice_kleinunternehmer: "false" });
});

describe("getEuerReport — receipts (Zuflussprinzip)", () => {
  test("sums payments received in the year, split into gross / net / VAT", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2025-03-03");
    insertPayment(inv, 0, "2025-12-31");
    const late = insertInvoice({ total: 238, taxTotal: 38 });
    insertPayment(late, 238, "2026-01-02"); // paid next year → not in 2025

    const report = getEuerReport({ year: 2025 });
    expect(report.year).toBe(2025);
    expect(report.receipts.gross).toBeCloseTo(1190, 2);
    expect(report.receipts.net).toBeCloseTo(1000, 2);
    expect(report.receipts.vat).toBeCloseTo(190, 2);
  });

  test("applies the invoice exchange rate", () => {
    const inv = insertInvoice({ total: 100, taxTotal: 0, exchangeRate: 1.5 });
    insertPayment(inv, 100, "2025-07-07");

    expect(getEuerReport({ year: 2025 }).receipts.gross).toBeCloseTo(150, 2);
  });
});

describe("getEuerReport — expenses by category", () => {
  test("groups expenses of the year by category with gross / net / VAT", () => {
    insertExpense({ category: "Software", amount: 100, taxAmount: 19, date: "2025-02-01" });
    insertExpense({ category: "Software", amount: 50, taxAmount: 9.5, date: "2025-11-01" });
    insertExpense({ category: "Hardware", amount: 200, taxAmount: 38, date: "2025-05-05" });
    insertExpense({ category: "Hardware", amount: 999, taxAmount: 0, date: "2024-12-31" }); // other year

    const { expenses } = getEuerReport({ year: 2025 });
    expect(expenses.gross).toBeCloseTo(119 + 59.5 + 238, 2);
    expect(expenses.net).toBeCloseTo(350, 2);
    expect(expenses.vat).toBeCloseTo(66.5, 2);
    expect(expenses.by_category.map((r) => r.category)).toEqual(["Hardware", "Software"]);
    expect(expenses.by_category[1]).toMatchObject({ category: "Software", count: 2, net: 150 });
  });

  test("uncategorised expenses land in an empty-string bucket", () => {
    insertExpense({ category: null, amount: 10, taxAmount: 0, date: "2025-02-01" });
    insertExpense({ category: "", amount: 5, taxAmount: 0, date: "2025-02-01" });

    const rows = getEuerReport({ year: 2025 }).expenses.by_category;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "", count: 2, gross: 15 });
  });
});

describe("getEuerReport — profit basis", () => {
  test("regular business: profit on net figures, VAT is a pass-through", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2025-03-03");
    insertExpense({ category: "Software", amount: 100, taxAmount: 19, date: "2025-02-01" });

    const report = getEuerReport({ year: 2025 });
    expect(report.kleinunternehmer).toBe(false);
    expect(report.profit).toBeCloseTo(1000 - 100, 2);
  });

  test("Kleinunternehmer: profit on gross figures (no VAT deduction)", () => {
    updateSettings({ einvoice_kleinunternehmer: "true" });
    const inv = insertInvoice({ total: 1000, taxTotal: 0 });
    insertPayment(inv, 1000, "2025-03-03");
    insertExpense({ category: "Software", amount: 100, taxAmount: 19, date: "2025-02-01" });

    const report = getEuerReport({ year: 2025 });
    expect(report.kleinunternehmer).toBe(true);
    expect(report.profit).toBeCloseTo(1000 - 119, 2);
  });
});

describe("EÜR routes", () => {
  test("GET /reports/euer returns the report for the requested year", async () => {
    const inv = insertInvoice({ total: 500, taxTotal: 0 });
    insertPayment(inv, 500, "2025-04-04");

    const res = await app.request("/api/v1/reports/euer?year=2025", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.year).toBe(2025);
    expect(data.receipts.gross).toBe(500);
  });

  test("GET /reports/euer rejects a nonsensical year", async () => {
    const res = await app.request("/api/v1/reports/euer?year=abc", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test("GET /reports/euer/csv lists receipts, each category and the profit", async () => {
    updateSettings({ einvoice_kleinunternehmer: "true" });
    const inv = insertInvoice({ total: 500, taxTotal: 0 });
    insertPayment(inv, 500, "2025-04-04");
    insertExpense({ category: "Software", amount: 119, taxAmount: 0, date: "2025-02-01" });

    const res = await app.request("/api/v1/reports/euer/csv?year=2025", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("euer-2025.csv");
    const body = await res.text();
    expect(body).toContain("Software");
    expect(body).toContain("381"); // profit 500 − 119
  });
});
