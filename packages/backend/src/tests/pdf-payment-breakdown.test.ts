import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer } from "../services/customer.service";
import { createInvoice, markSent } from "../services/invoice.service";
import { recordPayment } from "../services/payment.service";
import { buildInvoiceContext, renderInvoiceHtml } from "../services/pdf.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-pdf-payment-breakdown.db";

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();
  initDatabase();
  runMigrations();
  await seed();
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("PDF payment breakdown", () => {
  test("exposes a percentage cash discount for explicit template wording", () => {
    const customer = createCustomer({ name: "Skonto Customer" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 200 }],
      cash_discount_type: "percentage",
      cash_discount_value: 2,
      cash_discount_days: 14,
    });

    const ctx = buildInvoiceContext(inv.id)!;
    expect(ctx.has_cash_discount).toBe(true);
    expect(ctx.cash_discount_is_percentage).toBe(true);
    expect(ctx.cash_discount_is_amount).toBe(false);
    expect(ctx.cash_discount_value).toBe(2);
    expect(ctx.cash_discount_deadline).toContain("2026");
    expect(ctx.formatted_cash_discount).toContain("4");
    expect(ctx.formatted_cash_discounted_total).toContain("196");
  });

  test("bundled German template renders explicit cash discount payment terms", () => {
    const template = getDb()
      .query("SELECT id FROM templates WHERE type = 'builtin' AND name = 'Deutsch'")
      .get() as { id: string } | null;
    expect(template).not.toBeNull();

    const customer = createCustomer({ name: "Deutscher Kunde" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-08-23",
      currency: "EUR",
      locale: "de-DE",
      template_id: template!.id,
      items: [{ description: "Entwicklung", quantity: 1, unit_price: 1000 }],
      cash_discount_type: "percentage",
      cash_discount_value: 3,
      cash_discount_days: 7,
    });

    const html = renderInvoiceHtml(inv.id)!;
    expect(html).toContain("3 % Skonto");
    expect(html).toContain("Zahlungsbedingung:");
    expect(html).toContain("zu leistende Zahlung:");
    expect(html).toContain("970,00");
    expect(html).toContain("innerhalb von 7 Tagen");
  });

  test("buildInvoiceContext exposes payments, amount paid, and balance due", () => {
    const customer = createCustomer({ name: "Acme" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
    });
    markSent(inv.id);

    recordPayment(inv.id, { amount: 30, payment_date: "2026-01-05", method: "bank_transfer" });
    recordPayment(inv.id, { amount: 50, payment_date: "2026-01-20", method: "card" });

    const ctx = buildInvoiceContext(inv.id)!;
    expect(ctx.has_payments).toBe(true);
    expect(ctx.payments).toHaveLength(2);
    expect(ctx.payments[0].formatted_amount).toContain("50");
    expect(ctx.formatted_amount_paid).toContain("80");
    expect(ctx.formatted_balance_due).toContain("20");
  });

  test("default template renders the payments section only when payments exist", () => {
    const customer = createCustomer({ name: "Beta" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-02-01",
      items: [{ description: "Work", quantity: 1, unit_price: 200 }],
    });
    markSent(inv.id);

    // No payments yet: section must be hidden.
    const emptyHtml = renderInvoiceHtml(inv.id)!;
    expect(emptyHtml).not.toContain("Payments received");

    recordPayment(inv.id, { amount: 75, payment_date: "2026-02-10", method: "cash" });

    const html = renderInvoiceHtml(inv.id)!;
    expect(html).toContain("Payments received");
    expect(html).toContain("Balance Due");
    expect(html).toContain("cash");
    expect(html).toContain("75");
  });
});
