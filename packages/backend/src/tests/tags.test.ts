import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer, listCustomers, updateCustomer } from "../services/customer.service";
import {
  createInvoice,
  getInvoice,
  listInvoices,
  updateInvoice,
} from "../services/invoice.service";
import { getTagsForItem, listTags, removeItemTags, setItemTags } from "../services/tag.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-tags.db";
let app: Hono;
let token: string;

async function authed(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...((opts.headers as Record<string, string>) || {}),
    Authorization: `Bearer ${token}`,
  };
  if (!(opts.body instanceof FormData) && opts.method && opts.method !== "GET") {
    headers["Content-Type"] = "application/json";
  }
  return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
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
  const data = (await res.json()) as any;
  token = data.data.token;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

function makeCustomer(name: string, tags?: string[]) {
  return createCustomer({ name, tags });
}

function makeInvoice(customerId: string, tags?: string[]) {
  return createInvoice({
    customer_id: customerId,
    issue_date: "2026-01-01",
    items: [{ description: "Work", quantity: 1, unit_price: 100 }],
    tags,
  });
}

describe("tag service", () => {
  test("setItemTags creates tags and prunes unused rows", () => {
    const c = makeCustomer("TagCust");
    const stored = setItemTags(c.id, "customer", ["Urgent", "international", "urgent", "  "]);
    expect(stored).toEqual(["Urgent", "international"]);
    expect(getTagsForItem(c.id, "customer")).toEqual(["international", "Urgent"]);
    // unused tags are pruned after replace
    setItemTags(c.id, "customer", ["urgent"]);
    const all = listTags();
    expect(all.map((t) => t.name)).not.toContain("international");
  });

  test("case-insensitive re-add reuses the stored casing", () => {
    const c = makeCustomer("TagCust2");
    setItemTags(c.id, "customer", ["VIP"]);
    setItemTags(c.id, "customer", ["vip"]);
    expect(getTagsForItem(c.id, "customer")).toEqual(["VIP"]);
  });

  test("removeItemTags clears tags and prunes", () => {
    const c = makeCustomer("TagCust3", ["zebra"]);
    removeItemTags(c.id, "customer");
    expect(getTagsForItem(c.id, "customer")).toEqual([]);
    expect(listTags().map((t) => t.name)).not.toContain("zebra");
  });

  test("listTags reports usage counts", () => {
    const c1 = makeCustomer("TagCust4", ["shared"]);
    const c2 = makeCustomer("TagCust5", ["shared"]);
    makeInvoice(c2.id, ["shared"]);
    const all = listTags();
    const shared = all.find((t) => t.name === "shared");
    expect(shared?.count).toBe(3);
    void c1;
  });
});

describe("tags on invoices", () => {
  test("createInvoice and getInvoice expose tags", () => {
    const c = makeCustomer("InvCust");
    const inv = makeInvoice(c.id, ["Urgent", "web"]);
    const loaded = getInvoice(inv.id)!;
    expect(loaded.tags).toEqual(["Urgent", "web"]);
  });

  test("updateInvoice replaces tags", () => {
    const c = makeCustomer("InvCust2");
    const inv = makeInvoice(c.id, ["old-tag"]);
    updateInvoice(inv.id, {
      customer_id: c.id,
      issue_date: "2026-01-01",
      tags: ["new-tag"],
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
    });
    expect(getInvoice(inv.id)!.tags).toEqual(["new-tag"]);
  });

  test("list filter matches ANY of the given tags", () => {
    const c = makeCustomer("InvCust3");
    const a = makeInvoice(c.id, ["alpha"]);
    const b = makeInvoice(c.id, ["beta"]);
    const none = makeInvoice(c.id, []);
    const res = listInvoices({ page: 1, limit: 100, tags: "alpha,beta" });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(none.id);
    expect(res.items.find((i) => i.id === a.id)?.tags).toEqual(["alpha"]);
  });

  test("list filter is case-insensitive and ignores surrounding spaces", () => {
    const c = makeCustomer("InvCust4");
    const a = makeInvoice(c.id, ["Urgent"]);
    const res = listInvoices({ page: 1, limit: 100, tags: "urgent" });
    expect(res.items.map((i) => i.id)).toContain(a.id);
  });
});

describe("tags on customers", () => {
  test("create/update/get/list expose tags", () => {
    const c = makeCustomer("CustA", ["premium"]);
    expect(updateCustomer(c.id, { name: c.name, tags: ["platinum"] })!.tags).toEqual(["platinum"]);
    const listed = listCustomers({ page: 1, limit: 100, tags: "platinum" });
    expect(listed.items.map((i) => i.id)).toContain(c.id);
  });
});

describe("tags API", () => {
  test("CREATE /:id/tags with tags in full payload", async () => {
    const res = await authed("/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "ApiCust", tags: ["api", "priority"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.tags).toEqual(["api", "priority"]);
  });

  test("PUT /invoices/:id/tags replaces on any status", async () => {
    const cust = await authed("/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "ApiCust2" }),
    });
    const inv = await authed("/api/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: ((await cust.json()) as any).data.id,
        issue_date: "2026-01-01",
        items: [{ description: "Work", quantity: 1, unit_price: 100 }],
      }),
    });
    const invId = ((await inv.json()) as any).data.id;
    const upd = await authed(`/api/v1/invoices/${invId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: ["sent-tag", "followup"] }),
    });
    expect(upd.status).toBe(200);
    const detail = await authed(`/api/v1/invoices/${invId}`);
    expect(((await detail.json()) as any).data.tags).toEqual(["followup", "sent-tag"]);
  });

  test("PUT /customers/:id/tags", async () => {
    const cust = await authed("/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "ApiCust3" }),
    });
    const custId = ((await cust.json()) as any).data.id;
    const upd = await authed(`/api/v1/customers/${custId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: ["vip"] }),
    });
    expect(upd.status).toBe(200);
  });

  test("filter list endpoints by tags query param", async () => {
    const cust = await authed("/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "ApiCust4", tags: ["filter-me"] }),
    });
    const custId = ((await cust.json()) as any).data.id;
    const inv = await authed("/api/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: custId,
        issue_date: "2026-01-01",
        items: [{ description: "Work", quantity: 1, unit_price: 100 }],
        tags: ["filter-me"],
      }),
    });
    const invId = ((await inv.json()) as any).data.id;

    const custList = await authed("/api/v1/customers?tags=filter-me");
    expect(((await custList.json()) as any).data.items.map((i: any) => i.id)).toContain(custId);

    const invList = await authed("/api/v1/invoices?tags=filter-me");
    expect(((await invList.json()) as any).data.items.map((i: any) => i.id)).toContain(invId);

    const tagList = await authed("/api/v1/tags");
    expect(((await tagList.json()) as any).data.map((t: any) => t.name)).toContain("filter-me");
  });

  test("PUT /:id/tags on a missing item returns 404", async () => {
    const res = await authed("/api/v1/invoices/nope/tags", {
      method: "PUT",
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(res.status).toBe(404);
  });
});
