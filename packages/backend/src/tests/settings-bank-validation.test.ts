import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { getAllSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-settings-bank.db";
let app: Hono;
let token: string;

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

describe("bank detail validation on save", () => {
  test("accepts and normalizes a valid SEPA IBAN", async () => {
    const res = await saveSettings({ company_iban: "de89 3704 0044 0532 0130 00" });
    expect(res.status).toBe(200);
    expect(getAllSettings().company_iban).toBe("DE89370400440532013000");
  });

  test("accepts a valid BIC, uppercased", async () => {
    const res = await saveSettings({ company_bic: "cobadeffxxx" });
    expect(res.status).toBe(200);
    expect(getAllSettings().company_bic).toBe("COBADEFFXXX");
  });

  test("accepts clearing the IBAN", async () => {
    expect((await saveSettings({ company_iban: "" })).status).toBe(200);
    expect(getAllSettings().company_iban).toBe("");
    await saveSettings({ company_iban: "DE89370400440532013000" });
  });

  test("rejects an IBAN that fails its checksum", async () => {
    const res = await saveSettings({ company_iban: "DE88370400440532013000" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/IBAN/);
    // The previously stored, valid value survives a rejected save.
    expect(getAllSettings().company_iban).toBe("DE89370400440532013000");
  });

  test("rejects an IBAN from outside the SEPA area", async () => {
    const res = await saveSettings({ company_iban: "TR330006100519786457841326" });
    expect(res.status).toBe(400);
  });

  test("rejects a malformed BIC", async () => {
    const res = await saveSettings({ company_bic: "NOPE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/BIC/);
  });

  test("does not block saving unrelated settings alongside stored bank details", async () => {
    const res = await saveSettings({ company_phone: "+49 30 123456" });
    expect(res.status).toBe(200);
    expect(getAllSettings().company_phone).toBe("+49 30 123456");
  });
});
