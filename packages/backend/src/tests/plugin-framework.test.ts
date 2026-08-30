import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import {
  getBackendPlugin,
  getBackendPlugins,
  type PluginMigration,
  registerBackendPlugin,
} from "../plugins/registry";
import { runPluginMigrations } from "../plugins/runner";
import { getEnabledPluginIds, setPluginEnabled } from "../plugins/settings";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-plugin-framework.db";

let app: Hono;
let token: string;

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

function dummyPluginWithFlag(id: string, defaultEnabled: boolean) {
  return { ...dummyPlugin(id), defaultEnabled };
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "plugintestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  await seed();
  registerBackendPlugin({ ...dummyPlugin("zeta"), feature: "zeta-feature" });
  app = createApp();

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "plugintestadminpass" }),
  });
  token = ((await loginRes.json()) as any).data.token;
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

describe("plugin enablement", () => {
  test("plugins flagged defaultEnabled are on when the key is unset", () => {
    registerBackendPlugin(dummyPluginWithFlag("delta", true));
    registerBackendPlugin({ ...dummyPlugin("epsilon"), defaultEnabled: undefined });

    const enabled = getEnabledPluginIds();
    expect(enabled).toContain("delta");
    expect(enabled).not.toContain("epsilon");
  });

  test("toggle round-trip persists into the enabled_plugins setting", () => {
    setPluginEnabled("delta", false);
    expect(getEnabledPluginIds()).not.toContain("delta");
    expect(getBackendPlugins().length).toBeGreaterThan(0);

    setPluginEnabled("delta", true);
    expect(getEnabledPluginIds()).toContain("delta");

    const db = getDb();
    const raw = db.query("SELECT value FROM settings WHERE key = 'enabled_plugins'").get() as {
      value: string;
    };
    expect(JSON.parse(raw.value)).toContain("delta");
  });
});

describe("plugin catalog api", () => {
  function authed(path: string, opts: RequestInit = {}) {
    return app.request(
      new Request(`http://localhost${path}`, {
        ...opts,
        headers: {
          "Content-Type": "application/json",
          ...((opts.headers as Record<string, string>) || {}),
          Authorization: `Bearer ${token}`,
        },
      }),
    );
  }

  test("catalog lists plugins with enabled state", async () => {
    const res = await authed("/api/v1/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.plugins)).toBe(true);
    expect(body.data.plugins.some((p: any) => p.id === "alpha")).toBe(true);
    expect(Array.isArray(body.data.enabled)).toBe(true);
  });

  test("admin can toggle and un-toggle a plugin", async () => {
    const off = await authed("/api/v1/plugins/alpha", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    const list = (await (await authed("/api/v1/plugins")).json()) as any;
    expect(list.data.enabled).not.toContain("alpha");

    const on = await authed("/api/v1/plugins/alpha", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(((await on.json()) as any).data.enabled).toContain("alpha");
  });

  test("disabled plugin routes hit the enablement gate, not the router", async () => {
    setPluginEnabled("zeta", false);
    try {
      const res = await authed("/api/v1/plugins/zeta/nothing");
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toBe("Plugin not enabled");
      expect(body.plugin).toBe("zeta");

      setPluginEnabled("zeta", true);
      const enabledRes = await authed("/api/v1/plugins/zeta/nothing");
      // zeta's router is empty so Hono itself 404s, without the gate's body.
      expect(enabledRes.status).toBe(404);
      expect(await enabledRes.text()).not.toContain("Plugin not enabled");
    } finally {
      setPluginEnabled("zeta", true);
    }
  });

  test("toggle on unknown plugin returns 404", async () => {
    const res = await authed("/api/v1/plugins/nope", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });

  test("feature gate hook is consulted only for plugins declaring a feature", async () => {
    const { setPluginFeatureGate, getPluginFeatureGate } = await import("../plugins/feature-gate");

    // Default: pass-through, no policy installed.
    expect(getPluginFeatureGate()).toBeNull();

    const features: string[] = [];
    setPluginFeatureGate((feature) => async (_c, next) => {
      features.push(feature);
      await next();
    });
    try {
      // alpha declares no feature; zeta (registered in the top-level beforeAll
      // with feature: "zeta-feature") does. Both are enabled by default.
      await authed("/api/v1/plugins/alpha/nothing");
      const before = features.length; // alpha added nothing
      const res = await authed("/api/v1/plugins/zeta/nothing");
      // zeta's router is empty so the request 404s after the gate ran.
      expect(res.status).toBe(404);
      expect(features.length).toBe(before + 1);
      expect(features[features.length - 1]).toBe("zeta-feature");
    } finally {
      setPluginFeatureGate(null);
    }
  });
});
