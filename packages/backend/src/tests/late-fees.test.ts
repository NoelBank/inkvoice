import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer } from "../services/customer.service";
import { createInvoice, listInvoices, markSent } from "../services/invoice.service";
import { getAllSettings, updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-late-fees.db";

function makeInvoice(customerId: string, issueDate: string, dueDate: string, unitPrice = 100) {
  const inv = createInvoice({
    customer_id: customerId,
    issue_date: issueDate,
    due_date: dueDate,
    items: [{ description: "Work", quantity: 1, unit_price: unitPrice }],
  });
  markSent(inv.id);
  return inv;
}

function listAll() {
  return listInvoices({ page: 1, limit: 100 });
}

function dueDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
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

describe("late fee engine (percentage, once)", () => {
  test("applies a percentage fee on the overdue total and recomputes it", () => {
    updateSettings({
      late_fee_enabled: "true",
      late_fee_type: "percentage",
      late_fee_value: "5",
      late_fee_grace_days: "0",
      late_fee_frequency: "once",
    });

    const customer = createCustomer({ name: "Acme" });
    const inv = makeInvoice(customer.id, dueDaysAgo(10), dueDaysAgo(5), 100);

    const res = listAll();
    const item = res.items.find((i) => i.id === inv.id)!;
    expect(item.status).toBe("overdue");
    // 5% of 100 = 5; subtotal becomes 105, total 105.
    expect(item.total).toBe(105);
    expect(item.subtotal).toBe(105);

    const feeItems = getDb()
      .query("SELECT * FROM invoice_items WHERE invoice_id = ?")
      .all(inv.id) as Array<{ description: string; unit_price: number }>;
    expect(feeItems).toHaveLength(2);
    expect(feeItems[1].description).toBe("Late payment fee");
    expect(feeItems[1].unit_price).toBe(5);
  });

  test("is idempotent: repeated listing does not stack the fee", () => {
    const customer = createCustomer({ name: "Beta" });
    const inv = makeInvoice(customer.id, dueDaysAgo(10), dueDaysAgo(5), 100);

    listAll();
    listAll();
    listAll();
    const item = listAll().items.find((i) => i.id === inv.id)!;
    expect(item.total).toBe(105);
  });

  test("respects the grace period", () => {
    updateSettings({ ...getAllSettings(), late_fee_grace_days: "30" });
    const customer = createCustomer({ name: "Gamma" });
    // Overdue by 5 days but grace is 30: no fee.
    const inv = makeInvoice(customer.id, dueDaysAgo(10), dueDaysAgo(5), 100);
    const item = listAll().items.find((i) => i.id === inv.id)!;
    expect(item.total).toBe(100);
  });

  test("does nothing when disabled", () => {
    updateSettings({ ...getAllSettings(), late_fee_enabled: "false" });
    const customer = createCustomer({ name: "Delta" });
    const inv = makeInvoice(customer.id, dueDaysAgo(10), dueDaysAgo(5), 100);
    const item = listAll().items.find((i) => i.id === inv.id)!;
    expect(item.total).toBe(100);
  });
});

describe("late fee engine (fixed, monthly)", () => {
  test("applies fixed fee each month while overdue", () => {
    updateSettings({
      late_fee_enabled: "true",
      late_fee_type: "fixed",
      late_fee_value: "10",
      late_fee_grace_days: "0",
      late_fee_frequency: "monthly",
    });

    const customer = createCustomer({ name: "Epsilon" });
    const inv = makeInvoice(customer.id, dueDaysAgo(70), dueDaysAgo(65), 100);

    // First fee applies now (next_date set to +30d).
    const first = listAll().items.find((i) => i.id === inv.id)!;
    expect(first.total).toBe(110);

    // Simulate 31 days later: fee applies again.
    getDb().query("SELECT late_fee_next_date FROM invoices WHERE id = ?").get(inv.id) as {
      late_fee_next_date: string;
    };
    getDb()
      .query("UPDATE invoices SET late_fee_next_date = date('now', '-31 days') WHERE id = ?")
      .run(inv.id);

    const second = listAll().items.find((i) => i.id === inv.id)!;
    expect(second.total).toBe(120);
  });
});
