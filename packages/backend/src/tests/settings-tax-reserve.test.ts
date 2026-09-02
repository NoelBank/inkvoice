import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-settings-tax-reserve.db";
let app: Hono;
let token: string;

async function putSettings(body: Record<string, string>) {
  return app.request("/api/v1/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
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
  token = (await res.json()).data.token;
});

afterAll(() => {
  closeDatabase();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("tax reserve settings", () => {
  test("accepts and persists the three tax reserve keys", async () => {
    const res = await putSettings({
      tax_reserve_annual_salary: "60000",
      tax_reserve_joint_assessment: "true",
      tax_reserve_income_rate: "25",
    });
    expect(res.status).toBe(200);

    const get = await app.request("/api/v1/settings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { data } = await get.json();
    expect(data.tax_reserve_annual_salary).toBe("60000");
    expect(data.tax_reserve_joint_assessment).toBe("true");
    expect(data.tax_reserve_income_rate).toBe("25");
  });

  test("rejects a non-numeric salary instead of silently disabling tariff mode", async () => {
    const res = await putSettings({ tax_reserve_annual_salary: "sixty grand" });
    expect(res.status).toBe(400);
  });

  test("rejects an out-of-range flat rate", async () => {
    expect((await putSettings({ tax_reserve_income_rate: "-5" })).status).toBe(400);
    expect((await putSettings({ tax_reserve_income_rate: "150" })).status).toBe(400);
  });

  test("empty values are allowed (feature off / fallback)", async () => {
    const res = await putSettings({
      tax_reserve_annual_salary: "",
      tax_reserve_income_rate: "",
    });
    expect(res.status).toBe(200);
  });
});
