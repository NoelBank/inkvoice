import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { getStats, getTaxReserve } from "../services/dashboard.service";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";
import { extraTaxOnSideIncome } from "../utils/income-tax";

const TEST_DB = "./data/test-dashboard-tax-reserve.db";

// A fixed "now" so quarter/year windows are deterministic: 2026-08-15 → Q3 2026.
const NOW = new Date("2026-08-15T12:00:00Z");

let customerId: string;

function insertInvoice(opts: { total: number; taxTotal: number; exchangeRate?: number }): string {
  const db = getDb();
  const id = crypto.randomUUID().replaceAll("-", "");
  db.query(
    `INSERT INTO invoices (id, invoice_number, customer_id, status, issue_date, subtotal, tax_total, total, exchange_rate)
     VALUES (?, ?, ?, 'paid', '2026-07-01', ?, ?, ?, ?)`,
  ).run(
    id,
    `INV-${id.slice(0, 8)}`,
    customerId,
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

function insertExpense(opts: { amount: number; taxAmount: number; date: string }): void {
  getDb()
    .query(
      `INSERT INTO expenses (expense_date, amount, tax_amount, total, exchange_rate)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(opts.date, opts.amount, opts.taxAmount, opts.amount + opts.taxAmount);
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();

  const db = getDb();
  db.query(`INSERT INTO customers (id, name) VALUES ('cust-tax-reserve', 'Reserve GmbH')`).run();
  customerId = "cust-tax-reserve";
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
  updateSettings({
    tax_reserve_annual_salary: "",
    tax_reserve_joint_assessment: "false",
    tax_reserve_income_rate: "30",
  });
});

describe("getTaxReserve — VAT (current quarter, cash basis)", () => {
  test("VAT share of payments received this quarter minus input VAT", () => {
    // 1.190 gross / 190 VAT invoice, fully paid inside Q3 2026.
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2026-07-10");
    // Expense in the quarter with 19 € input VAT.
    insertExpense({ amount: 100, taxAmount: 19, date: "2026-08-01" });

    const reserve = getTaxReserve(NOW);
    expect(reserve.vat_reserve).toBeCloseTo(190 - 19, 2);
  });

  test("partial payments contribute their proportional VAT share", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 595, "2026-07-10"); // half the invoice → half the VAT

    expect(getTaxReserve(NOW).vat_reserve).toBeCloseTo(95, 2);
  });

  test("payments and expenses outside the quarter are ignored", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2026-06-30"); // Q2
    insertExpense({ amount: 100, taxAmount: 19, date: "2026-10-01" }); // Q4

    expect(getTaxReserve(NOW).vat_reserve).toBe(0);
  });

  test("converts foreign-currency invoices via their exchange rate", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190, exchangeRate: 2 });
    insertPayment(inv, 1190, "2026-07-10");

    expect(getTaxReserve(NOW).vat_reserve).toBeCloseTo(380, 2);
  });
});

describe("getTaxReserve — income tax (year to date)", () => {
  test("flat mode: rate × net profit when no salary is configured", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2026-03-01"); // earlier this year, net 1.000
    insertExpense({ amount: 200, taxAmount: 38, date: "2026-02-01" }); // net 200

    const reserve = getTaxReserve(NOW);
    expect(reserve.mode).toBe("flat");
    expect(reserve.income_tax_reserve).toBeCloseTo(0.3 * 800, 2);
  });

  test("flat mode never goes negative on a loss", () => {
    insertExpense({ amount: 500, taxAmount: 95, date: "2026-02-01" });

    expect(getTaxReserve(NOW).income_tax_reserve).toBe(0);
  });

  test("tariff mode: marginal tax on top of the configured salary", () => {
    updateSettings({ tax_reserve_annual_salary: "60000" });
    const inv = insertInvoice({ total: 11900, taxTotal: 1900 });
    insertPayment(inv, 11900, "2026-03-01"); // net profit 10.000

    const reserve = getTaxReserve(NOW);
    expect(reserve.mode).toBe("tariff");
    // Salary is reduced by the 1.230 € Arbeitnehmer-Pauschbetrag as a zvE proxy.
    expect(reserve.income_tax_reserve).toBe(extraTaxOnSideIncome(60000 - 1230, 10000, false));
  });

  test("tariff mode honours joint assessment", () => {
    updateSettings({
      tax_reserve_annual_salary: "60000",
      tax_reserve_joint_assessment: "true",
    });
    const inv = insertInvoice({ total: 11900, taxTotal: 1900 });
    insertPayment(inv, 11900, "2026-03-01");

    expect(getTaxReserve(NOW).income_tax_reserve).toBe(
      extraTaxOnSideIncome(60000 - 1230, 10000, true),
    );
  });

  test("payments from previous years are excluded", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2025-12-30");

    expect(getTaxReserve(NOW).income_tax_reserve).toBe(0);
  });
});

describe("getTaxReserve — shape", () => {
  test("total is the sum of both parts and getStats exposes the block", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190 });
    insertPayment(inv, 1190, "2026-07-10");

    const reserve = getTaxReserve(NOW);
    expect(reserve.total).toBeCloseTo(reserve.vat_reserve + reserve.income_tax_reserve, 2);
    expect(reserve.quarter).toBe("2026-Q3");
    expect(getStats().tax_reserve).toBeDefined();
  });
});

describe("getTaxReserve — § 19 UStG small business limits", () => {
  test("reports gross receipts of the previous and current calendar year against the limits", () => {
    const prev = insertInvoice({ total: 1190, taxTotal: 0 });
    insertPayment(prev, 1190, "2025-11-20");
    const cur = insertInvoice({ total: 500, taxTotal: 0 });
    insertPayment(cur, 500, "2026-02-02");
    insertPayment(cur, 0, "2024-12-31"); // older years are irrelevant

    const limits = getTaxReserve(NOW).small_business;
    expect(limits.previous_year).toEqual({ year: 2025, revenue: 1190, limit: 25_000 });
    expect(limits.current_year).toEqual({ year: 2026, revenue: 500, limit: 100_000 });
  });

  test("uses gross receipts (VAT-inclusive) converted via the exchange rate", () => {
    const inv = insertInvoice({ total: 1190, taxTotal: 190, exchangeRate: 2 });
    insertPayment(inv, 1190, "2026-05-05");

    expect(getTaxReserve(NOW).small_business.current_year.revenue).toBeCloseTo(2380, 2);
  });

  test("is zero with no payments", () => {
    const limits = getTaxReserve(NOW).small_business;
    expect(limits.previous_year.revenue).toBe(0);
    expect(limits.current_year.revenue).toBe(0);
  });
});
