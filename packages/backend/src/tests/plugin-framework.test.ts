import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import {
  getBackendPlugin,
  getBackendPlugins,
  type PluginMigration,
  registerBackendPlugin,
} from "../plugins/registry";
import { runPluginMigrations } from "../plugins/runner";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-plugin-framework.db";

function dummyPlugin(id: string) {
  return {
    id,
    routes: new Hono(),
    migrations: [
      {
        version: 1,
        name: `test_${id}`,
        up: (db: Database) => {
          db.exec(`CREATE TABLE IF NOT EXISTS test_${id.replace(/-/g, "_")} (id TEXT PRIMARY KEY)`);
        },
      },
    ] as PluginMigration[],
    defaultEnabled: true as const,
  };
}

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "plugintestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();
  initDatabase();
  runMigrations();
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("backend plugin registry", () => {
  test("registers and retrieves a plugin", () => {
    registerBackendPlugin(dummyPlugin("alpha"));
    expect(getBackendPlugin("alpha")?.id).toBe("alpha");
    expect(getBackendPlugins().some((p) => p.id === "alpha")).toBe(true);
  });

  test("re-registering the same id replaces the entry (HMR-safe)", () => {
    const first = dummyPlugin("alpha");
    registerBackendPlugin(first);
    const second = { ...dummyPlugin("alpha"), defaultEnabled: false };
    registerBackendPlugin(second);
    const all = getBackendPlugins().filter((p) => p.id === "alpha");
    expect(all).toHaveLength(1);
    expect(all[0].defaultEnabled).toBe(false);
  });
});

describe("runPluginMigrations", () => {
  test("creates the tracking table and applies pending versions once", () => {
    registerBackendPlugin(dummyPlugin("beta"));
    runPluginMigrations();
    runPluginMigrations(); // idempotent

    const db = getDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'test_%'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("test_beta");

    const rows = db
      .query(
        "SELECT version, name FROM plugin_schema_migrations WHERE plugin_id = 'alpha' OR plugin_id = 'beta' ORDER BY plugin_id",
      )
      .all() as { version: number; name: string }[];
    expect(rows).toEqual([
      { version: 1, name: "test_alpha" },
      { version: 1, name: "test_beta" },
    ]);
  });

  test("respects a pre-seeded plugin_schema_migrations row (upgraded cloud tenant)", () => {
    const db = getDb();
    db.run(
      "INSERT OR IGNORE INTO plugin_schema_migrations (plugin_id, version, name) VALUES ('gamma', 1, 'time_tracker_tables')",
    );
    registerBackendPlugin(dummyPlugin("gamma"));
    runPluginMigrations();

    // v1 must NOT run again (table row exists), so the marker stays a single row.
    const rows = db
      .query("SELECT COUNT(*) as count FROM plugin_schema_migrations WHERE plugin_id = 'gamma'")
      .get() as { count: number };
    expect(rows.count).toBe(1);
  });
});
