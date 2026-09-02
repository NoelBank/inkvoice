import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-settings-plugin-catalog.db";
let app: Hono;
let token: string;

function getSettings() {
  return app.request("/api/v1/settings", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function saveSettings(body: Record<string, string>) {
  return app.request(
    new Request("http://localhost/api/v1/settings", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123456";
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
    body: JSON.stringify({ username: "admin", password: "testpass123456" }),
  });
  token = ((await res.json()) as { data: { token: string } }).data.token;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("internal catalog keys are hidden from settings payloads", () => {
  test("GET omits plugin_catalog_cache, plugin_catalog_synced_at and plugin_catalog_votes", async () => {
    updateSettings({
      plugin_catalog_cache: '{"schema":1,"plugins":[]}',
      plugin_catalog_synced_at: "2026-09-01T00:00:00.000Z",
      plugin_catalog_votes: '{"accounts-payable":3}',
    });
    const res = await getSettings();
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, string> }).data;
    expect(data).not.toHaveProperty("plugin_catalog_cache");
    expect(data).not.toHaveProperty("plugin_catalog_synced_at");
    expect(data).not.toHaveProperty("plugin_catalog_votes");
  });

  test("PUT response omits the internal keys but keeps plugin_catalog_url", async () => {
    updateSettings({ plugin_catalog_cache: '{"schema":1,"plugins":[]}' });
    const res = await saveSettings({ plugin_catalog_url: "" });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, string> }).data;
    expect(data.plugin_catalog_url).toBe("");
    expect(data).not.toHaveProperty("plugin_catalog_cache");
    expect(data).not.toHaveProperty("plugin_catalog_synced_at");
    expect(data).not.toHaveProperty("plugin_catalog_votes");
  });
});

describe("plugin_catalog_url validation on save", () => {
  test("accepts an empty value, meaning egress off", async () => {
    const res = await saveSettings({ plugin_catalog_url: "" });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, string> }).data;
    expect(data.plugin_catalog_url).toBe("");
  });

  test("accepts a valid https URL", async () => {
    const url = "https://example.test/plugins/catalog.v1.json";
    const res = await saveSettings({ plugin_catalog_url: url });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, string> }).data;
    expect(data.plugin_catalog_url).toBe(url);
  });

  test("rejects a plaintext http URL", async () => {
    // Every other server-side fetch of a user-supplied URL is HTTPS-only
    // (utils/ssrf-protection.ts); accepting http here would have made the
    // catalog the one exception, on the one setting that makes the server
    // issue a request to an address the caller chose.
    const res = await saveSettings({ plugin_catalog_url: "http://example.test/catalog.v1.json" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/https/i);
  });

  test("rejects a non-URL value with 400 and keeps the stored value", async () => {
    const res = await saveSettings({ plugin_catalog_url: "not a url" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/plugin_catalog_url/);
    const after = ((await (await getSettings()).json()) as { data: Record<string, string> }).data;
    expect(after.plugin_catalog_url).toBe("https://example.test/plugins/catalog.v1.json");
  });
});
