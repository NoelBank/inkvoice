import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer, getCustomer } from "../services/customer.service";
import { createCreditNote, createInvoice, markSent } from "../services/invoice.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-credit-alert.db";

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

describe("customer available credit", () => {
  test("exposes zero credit when none exists", () => {
    const customer = createCustomer({ name: "Noa" });
    expect(getCustomer(customer.id)!.available_credit).toBe(0);
  });

  test("surfaces issued credit notes as positive available credit", () => {
    const customer = createCustomer({ name: "Acme" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
    });
    markSent(inv.id);
    const res = createCreditNote(inv.id);
    expect(res.success).toBe(true);
    markSent(res.data.id);

    // Credit note total is -100; available credit is +100.
    expect(getCustomer(customer.id)!.available_credit).toBe(100);
  });
});
