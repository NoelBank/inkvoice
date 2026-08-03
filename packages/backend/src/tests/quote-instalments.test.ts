import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer } from "../services/customer.service";
import { getInvoice } from "../services/invoice.service";
import {
  convertQuoteToInvoices,
  createQuote,
  listQuoteInstalments,
} from "../services/quote.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-quote-instalments.db";

function makeQuote(
  customerId: string,
  items: { unit_price: number; tax_rate?: number }[],
  discount?: { type: string; value: number },
) {
  return createQuote({
    customer_id: customerId,
    issue_date: "2026-01-01",
    valid_until: "2026-03-01",
    currency: "USD",
    discount_type: discount?.type || null,
    discount_value: discount?.value || 0,
    items: items.map((it, i) => ({
      description: `Item ${i + 1}`,
      quantity: 1,
      unit_price: it.unit_price,
      tax_rate: it.tax_rate ?? 0,
    })),
  });
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
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("quote to instalment invoices", () => {
  test("percent split 40/40/20 creates 3 invoices summing to the quote total", () => {
    const customer = createCustomer({ name: "Acme" });
    const quote = makeQuote(customer.id, [{ unit_price: 100 }, { unit_price: 50 }]);

    const res = convertQuoteToInvoices(quote.id, [
      { value: 40, unit: "percent", due_offset_days: 0, label: "Deposit" },
      { value: 40, unit: "percent", due_offset_days: 14 },
      { value: 20, unit: "percent", due_offset_days: 30 },
    ]);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.invoices).toHaveLength(3);
    expect(res.data.invoices[0].label).toBe("Deposit");
    expect(res.data.invoices[2].label).toBe("Final");

    const sumTotal = res.data.invoices.reduce((a, i) => a + i.total, 0);
    expect(sumTotal).toBe(quote.total);

    const instalments = listQuoteInstalments(quote.id);
    expect(instalments).toHaveLength(3);
    expect(instalments[0].seq).toBe(1);
  });

  test("flat deposit plus percentage balance", () => {
    const customer = createCustomer({ name: "Beta" });
    const quote = makeQuote(customer.id, [{ unit_price: 200 }]);

    const res = convertQuoteToInvoices(quote.id, [
      { value: 50, unit: "amount", due_offset_days: 0, label: "Deposit" },
      { value: 75, unit: "percent", due_offset_days: 30 },
    ]);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.invoices[0].total).toBe(50);
    expect(res.data.invoices).toHaveLength(2);
  });

  test("rounding drift is absorbed into the final invoice", () => {
    const customer = createCustomer({ name: "Gamma" });
    const quote = makeQuote(customer.id, [{ unit_price: 99.99 }]);

    const res = convertQuoteToInvoices(quote.id, [
      { value: 33.33, unit: "percent", due_offset_days: 0 },
      { value: 33.33, unit: "percent", due_offset_days: 14 },
      { value: 33.34, unit: "percent", due_offset_days: 30 },
    ]);
    expect(res.success).toBe(true);
    if (!res.success) return;

    const sumTotal = res.data.invoices.reduce((a, i) => a + i.total, 0);
    expect(sumTotal).toBe(quote.total);

    const last = getInvoice(res.data.invoices[2].id)!;
    expect(last.items.some((it) => it.description === "Rounding adjustment")).toBe(true);
  });

  test("rejects instalments that do not total 100%", () => {
    const customer = createCustomer({ name: "Delta" });
    const quote = makeQuote(customer.id, [{ unit_price: 100 }]);

    const res = convertQuoteToInvoices(quote.id, [
      { value: 50, unit: "percent", due_offset_days: 0 },
      { value: 30, unit: "percent", due_offset_days: 14 },
    ]);
    expect(res.success).toBe(false);
  });

  test("rejects a second conversion of the same quote", () => {
    const customer = createCustomer({ name: "Epsilon" });
    const quote = makeQuote(customer.id, [{ unit_price: 100 }]);

    const first = convertQuoteToInvoices(quote.id, [
      { value: 100, unit: "percent", due_offset_days: 0 },
    ]);
    expect(first.success).toBe(true);
    const second = convertQuoteToInvoices(quote.id, [
      { value: 100, unit: "percent", due_offset_days: 0 },
    ]);
    expect(second.success).toBe(false);
  });
});
