import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { setPluginEntitlementCheck } from "../plugins/entitlement";
import { runPluginMigrations } from "../plugins/runner";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-plugin-catalog-routes.db";

let app: Hono;
let token: string;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "admin-password-1";
  process.env.JWT_SECRET = "test-secret-that-is-at-least-32-chars";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
  runPluginMigrations();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin-password-1" }),
  });
  const body = (await res.json()) as { data: { token: string } };
  token = body.data.token;
});

afterAll(() => {
  closeDatabase();
  // SQLite leaves -wal and -shm alongside the db; the existing suites clean all
  // three, and leaving them behind makes a later run start from stale state.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {
      // best effort
    }
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setPluginEntitlementCheck(null);
});

// Evaluated per call: `token` is only assigned in beforeAll, and a module-level
// const would capture "undefined" before that.
function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("GET /api/v1/plugins/catalog", () => {
  test("returns the merged payload with provenance", async () => {
    updateSettings({ plugin_catalog_url: "" }); // snapshot only, no egress
    const res = await app.request("/api/v1/plugins/catalog", { headers: auth() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: {
        plugins: { id: string; installed: boolean; blockedReason: string | null }[];
        catalog: { source: string; syncedAt: string | null; error: string | null };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.catalog.source).toBe("snapshot");

    const tt = body.data.plugins.find((p) => p.id === "time-tracker");
    expect(tt).toBeDefined();
    expect(tt!.installed).toBe(true);
    expect(tt!.blockedReason).toBeNull();
  });

  test("shows a cloud-only plugin as blocked rather than enableable", async () => {
    updateSettings({ plugin_catalog_url: "" });
    const res = await app.request("/api/v1/plugins/catalog", { headers: auth() });
    const body = (await res.json()) as {
      data: { plugins: { id: string; blockedReason: string | null }[] };
    };
    const peppol = body.data.plugins.find((p) => p.id === "peppol");
    expect(peppol).toBeDefined();
    expect(peppol!.blockedReason).toBe("cloud_only");
  });

  test("requires authentication", async () => {
    const res = await app.request("/api/v1/plugins/catalog");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/plugins/catalog/refresh", () => {
  test("forces a re-sync for an admin", async () => {
    updateSettings({ plugin_catalog_url: "https://example.test/catalog.v1.json" });
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ schema: 1, plugins: [] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const res = await app.request("/api/v1/plugins/catalog/refresh", {
      method: "POST",
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect(calls).toBeGreaterThan(0);
  });

  test("rejects an unauthenticated caller", async () => {
    const res = await app.request("/api/v1/plugins/catalog/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/plugins/catalog/vote", () => {
  test("forwards the id and returns the new count", async () => {
    updateSettings({ plugin_catalog_url: "https://example.test/catalog.v1.json" });
    const calls: string[] = [];
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push((init?.body as string) ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ count: 9, voted: true }), { status: 200 }),
      );
    }) as typeof fetch;

    const res = await app.request("/api/v1/plugins/catalog/vote", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: "accounts-payable" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { count: number | null } };
    expect(json.data.count).toBe(9);
    expect(calls[0]).toContain("accounts-payable");
  });

  test("is a no-op with egress off, and opens no socket", async () => {
    updateSettings({ plugin_catalog_url: "" });
    globalThis.fetch = (() => {
      throw new Error("must not fetch with egress off");
    }) as unknown as typeof fetch;

    const res = await app.request("/api/v1/plugins/catalog/vote", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: "accounts-payable" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { count: number | null } };
    expect(json.data.count).toBeNull();
  });

  test("rejects a malformed body", async () => {
    const res = await app.request("/api/v1/plugins/catalog/vote", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
