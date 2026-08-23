import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer } from "../services/customer.service";
import { createInvoice, getInvoice, markSent, updateInvoice } from "../services/invoice.service";
import { deletePayment, recordPayment } from "../services/payment.service";
import { cashDiscountDeadline, cashDiscountOn, hasCashDiscount } from "../utils/cash-discount";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-cash-discount.db";

function makeInvoice(
  customerId: string,
  opts?: {
    issueDate?: string;
    cashDiscountType?: string;
    cashDiscountValue?: number;
    cashDiscountDays?: number;
  },
) {
  const inv = createInvoice({
    customer_id: customerId,
    issue_date: opts?.issueDate || "2026-01-01",
    items: [{ description: "Work", quantity: 1, unit_price: 200 }],
    cash_discount_type: opts?.cashDiscountType ?? "percentage",
    cash_discount_value: opts?.cashDiscountValue ?? 0,
    cash_discount_days: opts?.cashDiscountDays ?? 0,
  });
  markSent(inv.id);
  return inv;
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

describe("cash discount maths", () => {
  test("disabled when days is 0 or value is 0", () => {
    expect(hasCashDiscount({ type: "percentage", value: 2, days: 0 })).toBe(false);
    expect(hasCashDiscount({ type: "percentage", value: 0, days: 10 })).toBe(false);
    expect(hasCashDiscount({ type: null, value: 2, days: 10 })).toBe(false);
    expect(hasCashDiscount({ type: "percentage", value: 2, days: 10 })).toBe(true);
  });

  test("percentage discount scales with the amount", () => {
    expect(cashDiscountOn(200, { type: "percentage", value: 2, days: 10 })).toBe(4);
    expect(cashDiscountOn(75.5, { type: "percentage", value: 2, days: 10 })).toBe(1.51);
  });

  test("flat discount is capped at the amount", () => {
    expect(cashDiscountOn(200, { type: "amount", value: 25, days: 10 })).toBe(25);
    expect(cashDiscountOn(10, { type: "amount", value: 25, days: 10 })).toBe(10);
  });

  test("deadline is issue date plus days", () => {
    expect(cashDiscountDeadline("2026-01-01", 14)).toBe("2026-01-15");
  });
});

describe("cash discount on invoices", () => {
  test("persists and exposes the discount fields", () => {
    const customer = createCustomer({ name: "Acme" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
      cash_discount_type: "percentage",
      cash_discount_value: 2,
      cash_discount_days: 14,
    });
    const loaded = getInvoice(inv.id)!;
    expect(loaded.cash_discount_type).toBe("percentage");
    expect(loaded.cash_discount_value).toBe(2);
    expect(loaded.cash_discount_days).toBe(14);
  });

  test("clearing the discount type also clears stale value and day fields", () => {
    const customer = createCustomer({ name: "No Skonto" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
      cash_discount_type: "percentage",
      cash_discount_value: 2,
      cash_discount_days: 14,
    });

    updateInvoice(inv.id, {
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
      cash_discount_type: null,
      cash_discount_value: 2,
      cash_discount_days: 14,
    });

    const loaded = getInvoice(inv.id)!;
    expect(loaded.cash_discount_type).toBeNull();
    expect(loaded.cash_discount_value).toBe(0);
    expect(loaded.cash_discount_days).toBe(0);
  });

  test("settles for less when paid inside the window", () => {
    const customer = createCustomer({ name: "Beta" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 }); // total 200, 5% = 10
    const res = recordPayment(inv.id, {
      amount: 190, // 200 - 10 discount
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(true);
    const loaded = getInvoice(inv.id)!;
    expect(loaded.status).toBe("paid");
    expect(loaded.amount_paid).toBe(190);
    expect(loaded.cash_discount_applied).toBe(10);
  });

  test("rejects application after the window passes", () => {
    const customer = createCustomer({ name: "Gamma" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, {
      amount: 190,
      payment_date: "2026-02-01",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("window");
  });

  test("rejects application when no discount is configured", () => {
    const customer = createCustomer({ name: "Delta" });
    const inv = makeInvoice(customer.id, { cashDiscountDays: 0 });
    const res = recordPayment(inv.id, {
      amount: 190,
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(false);
  });

  test("rejects an amount that does not match the discounted balance", () => {
    const customer = createCustomer({ name: "Epsilon" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, {
      amount: 150,
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("discounted balance");
  });

  test("a payment without the flag is recorded at full amount", () => {
    const customer = createCustomer({ name: "Zeta" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, { amount: 200, payment_date: "2026-01-10" });
    expect(res.success).toBe(true);
    expect(getInvoice(inv.id)!.status).toBe("paid");
    expect(getInvoice(inv.id)!.cash_discount_applied).toBe(0);
  });

  test("deleting a discount payment restores the unsettled balance", () => {
    const customer = createCustomer({ name: "Eta" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, {
      amount: 190,
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    deletePayment(res.data.id);
    const loaded = getInvoice(inv.id)!;
    expect(loaded.amount_paid).toBe(0);
    expect(loaded.cash_discount_applied).toBe(0); // discount relinquished with the payment
    expect(loaded.status).toBe("sent");
  });
});
