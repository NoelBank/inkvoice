import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { renderInvoiceHtml } from "../services/pdf.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-consolidated-invoices.db";
let app: Hono;
let token: string;
let customerId: string;
let customerBId: string;

async function authed(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...((opts.headers as Record<string, string>) || {}),
    Authorization: `Bearer ${token}`,
  };
  if (opts.method && opts.method !== "GET") headers["Content-Type"] = "application/json";
  return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
}

async function createDraft(overrides: Record<string, unknown> = {}) {
  const res = await authed("/api/v1/invoices", {
    method: "POST",
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-06-01",
      items: [{ description: "Service", quantity: 1, unit_price: 100 }],
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).data;
}

async function createCustomer(name: string, email: string) {
  const res = await authed("/api/v1/customers", {
    method: "POST",
    body: JSON.stringify({ name, email }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).data.id;
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

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "testpass123" }),
  });
  token = ((await res.json()) as any).data.token;

  customerId = await createCustomer("Consolidated Corp", "consolidated@example.com");
  customerBId = await createCustomer("Other Client", "other@example.com");
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

function consolidate(payload: Record<string, unknown>) {
  return authed("/api/v1/invoices/consolidate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

describe("Consolidated invoices — backend", () => {
  test("merges drafts, keeps exact summed totals, groups per source", async () => {
    const inv1 = await createDraft({
      items: [
        { description: "Design", quantity: 2, unit_price: 100, tax_rate: 10 }, // 200 + 20 tax
        { description: "Setup", quantity: 1, unit_price: 50, tax_rate: 0 }, // 50
      ],
    });
    const inv2 = await createDraft({
      items: [{ description: "Hosting", quantity: 3, unit_price: 40, tax_rate: 20 }], // 120 + 24 tax
    });
    const inv3 = await createDraft({
      items: [{ description: "Consulting", quantity: 1, unit_price: 230.5, tax_rate: 0 }],
    });

    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv1.id, inv2.id, inv3.id],
    });
    expect(res.status).toBe(201);
    const data = ((await res.json()) as any).data;

    // 200 + 50 + 120 + 230.5 = 600.5 subtotal; 20 + 24 = 44 tax; 644.5 total
    expect(data.status).toBe("draft");
    expect(data.subtotal).toBeCloseTo(600.5, 6);
    expect(data.tax_total).toBeCloseTo(44, 6);
    expect(data.total).toBeCloseTo(644.5, 6);
    expect(data.items).toHaveLength(4);
    expect(data.consolidation.sources).toHaveLength(3);
    expect(data.consolidation.sources.map((s: any) => s.invoice_number)).toEqual([
      inv1.invoice_number,
      inv2.invoice_number,
      inv3.invoice_number,
    ]);
  });

  test("consolidated draft is editable and mark-sent assigns a number", async () => {
    const inv1 = await createDraft();
    const inv2 = await createDraft();
    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv1.id, inv2.id],
    });
    const data = ((await res.json()) as any).data;

    const sent = await authed(`/api/v1/invoices/${data.id}/mark-sent`, { method: "POST" });
    expect(sent.status).toBe(200);
    const sentData = ((await sent.json()) as any).data;
    expect(sentData.status).toBe("sent");
    expect(sentData.invoice_number).toMatch(/^INV-/);
  });

  test("applies a single discount to the merged subtotal", async () => {
    const inv1 = await createDraft();
    const inv2 = await createDraft();
    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv1.id, inv2.id],
      discount_type: "percentage",
      discount_value: 10,
    });
    expect(res.status).toBe(201);
    const data = ((await res.json()) as any).data;
    // subtotal 200, 10% discount, no tax
    expect(data.discount_type).toBe("percentage");
    expect(data.discount_amount).toBeCloseTo(20, 6);
    expect(data.total).toBeCloseTo(180, 6);
  });

  test("rejects consolidating fewer than two invoices", async () => {
    const inv = await createDraft();
    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv.id],
    });
    expect(res.status).toBe(400);
  });

  test("deduplicates repeated source ids", async () => {
    const inv = await createDraft();
    const alone = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv.id, inv.id],
    });
    expect(alone.status).toBe(400);

    const inv2 = await createDraft();
    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv.id, inv2.id, inv.id],
    });
    expect(res.status).toBe(201);
    const data = ((await res.json()) as any).data;
    expect(data.consolidation.sources).toHaveLength(2);
  });

  test("rejects consolidating a non-draft invoice", async () => {
    const inv1 = await createDraft();
    const inv2 = await createDraft();
    await authed(`/api/v1/invoices/${inv2.id}/mark-sent`, { method: "POST" });

    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv1.id, inv2.id],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain("must be a draft");
  });

  test("rejects consolidating invoices from different customers", async () => {
    const own = await createDraft();
    const res = await authed("/api/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerBId,
        issue_date: "2026-06-01",
        items: [{ description: "Other", quantity: 1, unit_price: 10 }],
      }),
    });
    const other = ((await res.json()) as any).data;

    const res2 = await consolidate({
      customer_id: customerId,
      invoice_ids: [own.id, other.id],
    });
    expect(res2.status).toBe(400);
    const data = (await res2.json()) as any;
    expect(data.error).toContain("different customer");
  });

  test("rejects consolidating drafts in different currencies", async () => {
    const usd = await createDraft();
    const eur = await createDraft({ currency: "EUR" });

    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [usd.id, eur.id],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain("different currencies");
  });

  test("PDF renders per-source headers and subtotal rows", async () => {
    const inv1 = await createDraft({
      items: [{ description: "Alpha", quantity: 1, unit_price: 10 }],
    });
    const inv2 = await createDraft({
      items: [{ description: "Beta", quantity: 1, unit_price: 20 }],
    });
    const res = await consolidate({
      customer_id: customerId,
      invoice_ids: [inv1.id, inv2.id],
    });
    const data = ((await res.json()) as any).data;

    const html = renderInvoiceHtml(data.id)!;
    expect(html).toContain(inv1.invoice_number);
    expect(html).toContain(inv2.invoice_number);
    expect(html).toMatch(/Subtotal/);
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
  });
});
