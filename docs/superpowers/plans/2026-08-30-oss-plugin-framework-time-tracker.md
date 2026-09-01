# OSS Plugin Framework + Time Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the time-tracker feature from the Inkvoice Cloud overlay into the OSS repo as the first official plugin, giving OSS a reusable statically-compiled plugin framework and the cloud overlay a single shared stack.

**Architecture:** OSS gains the backend plugin registry, enablement store, gate, catalog API, migration runner, and the frontend plugin framework. The time tracker is ported from `inkvoice-cloud` into OSS with new ownership scoping. The cloud overlay then deletes its duplicate framework, registers its premium plugins (`france`, `peppol`) into the OSS registry, and injects plan gating via a hook. One catalog, one `enabled_plugins` KV key, one Plugins settings tab.

**Tech Stack:** Bun + Hono v4, `bun:sqlite`, Zod, React 19 + Vite, Zustand, `bun:test`.

**Spec:** `inkvoice/specs/2026-08-30-oss-plugin-framework-time-tracker-design.md` (read it first; this plan argues from it)

## Global Constraints

- Repos: Phase A (Tasks 1-9) happens entirely in `/Users/baris/projects/inhouse/inkvoice-mono/inkvoice/` (OSS, MIT). Phase B (Tasks 10-13) in `inkvoice-cloud/`. Never edit `inkvoice-cloud/vendor/inkvoice-oss/`.
- No new runtime dependencies. Use existing stack only: `bun:sqlite`, `hono`, `zod`, `bcryptjs`, `zustand`, existing shadcn components.
- SQL conventions: `bun:sqlite` prepared statements, ISO 8601 TEXT dates, hex random ids via `crypto.randomUUID().replace(/-/g, "")` (matches cloud plugin style) or `crypto.randomBytes(16).toString("hex")` (matches OSS seed style; both are fine).
- API responses: `{ success: true, data }` or `{ success: false, error }`.
- i18n: every user-facing string via `t("key")`; keys registered via `registerTranslations` for all 5 languages (en, tr, es, de, fr).
- No em dashes or en dashes anywhere, including code comments. Use commas, periods, or parentheses.
- Do not add comments beyond what the ported code already carries.
- Schema continuity is a hard requirement: `tt_projects`, `tt_time_entries`, migration name `time_tracker_tables` at version 1, and the `enabled_plugins` settings key must remain byte-identical to the cloud versions.
- Backend tests: `bun:test` with a dedicated `./data/test-*.db` file per suite, env set in `beforeAll`, `resetEnvCache()`, cleanup in `afterAll` (see `packages/backend/src/tests/tags.test.ts` for the exact pattern to copy).
- Commits: title line only, no body, no Co-Authored-By. Commit in the repo you edited, never at `inkvoice-mono/` level.
- Verification command: `bun run check` (lint + typecheck + test) in `inkvoice/`.

---

## File Structure (Phase A, OSS)

```
packages/backend/src/plugins/            NEW framework + first plugin
  registry.ts       BackendPlugin interface, registerBackendPlugin()
  settings.ts       enablement via enabled_plugins KV
  feature-gate.ts   injectable plan-feature policy hook
  gate.ts           pluginGate middleware (404 when disabled)
  routes.ts         GET/PUT /api/v1/plugins catalog
  runner.ts         runPluginMigrations(db) + plugin_schema_migrations DDL
  index.ts          barrel, side-effect imports official OSS plugins
  time-tracker/
    migrations.ts   tt_projects + tt_time_entries (verbatim from cloud)
    service.ts      business logic + ownership scoping + edit guard hook
    index.ts        Hono routes, registered at import
packages/backend/src/tests/
  plugin-framework.test.ts
  time-tracker.test.ts
packages/backend/src/database/seed.ts    + demo time data
packages/backend/src/app.ts              plugin mounting
packages/backend/src/index.ts            runPluginMigrations() in boot
packages/backend/src/routes/export.ts    backup + wipe coverage for tt_ tables
packages/frontend/src/plugins/           NEW framework mirror of cloud's
  api.ts, registry.ts, use-plugins.store.ts, PluginGuard.tsx,
  install-nav-gate.ts, PluginsSettingsTab.tsx, i18n.ts, index.tsx
  time-tracker/{api.ts, i18n.ts, index.tsx, TimeTrackingPage.tsx}
packages/frontend/src/tests/plugins-bootstrap.test.ts
packages/frontend/src/registrations.tsx  imports the plugins barrel
docs/features/plugins.md + docs/features/index.md entry
```

---

### Task 1: Backend plugin registry + migration runner

**Files:**
- Create: `packages/backend/src/plugins/registry.ts`
- Create: `packages/backend/src/plugins/runner.ts`
- Test: `packages/backend/src/tests/plugin-framework.test.ts`

**Interfaces:**
- Consumes: OSS `getDb()` from `database/connection`, `logger` from `utils/logger`.
- Produces (used by Tasks 3, 4, 5 and by cloud in Phase B):
  - `interface PluginMigration { version: number; name: string; up: (db: Database) => void }`
  - `interface BackendPlugin { id: string; routes: Hono; migrations: PluginMigration[]; defaultEnabled?: boolean; feature?: string }`
  - `registerBackendPlugin(plugin: BackendPlugin): void` (replaces by id)
  - `getBackendPlugins(): BackendPlugin[]`, `getBackendPlugin(id: string): BackendPlugin | undefined`
  - `runPluginMigrations(): void` (uses ALS-bound `getDb()`)

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/tests/plugin-framework.test.ts`:

```ts
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import {
  getBackendPlugin,
  getBackendPlugins,
  registerBackendPlugin,
  type PluginMigration,
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
```

The tests:

```ts
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
```

The `dummyPlugin` helper returns a `BackendPlugin`-shaped object; the `up` param is typed `db: Database` (from `bun:sqlite`) and the migrations array `PluginMigration[]`, both imported at the top of the file as shown.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice && bun test packages/backend/src/tests/plugin-framework.test.ts`
Expected: FAIL, module `../plugins/registry` not found.

- [ ] **Step 3: Write the registry**

Create `packages/backend/src/plugins/registry.ts`:

```ts
// Statically compiled-in official plugins. A plugin is one self-contained
// folder that calls registerBackendPlugin() at import time; the barrel
// (./index.ts) side-effect-imports them so the registry is populated before
// runPluginMigrations() and route mounting in app.ts. Overlays register their
// own plugins into this same registry from their bootstrap.

import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

/** A schema migration owned by a plugin, tracked independently of core
 *  migrations in plugin_schema_migrations keyed by (plugin_id, version). */
export interface PluginMigration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export interface BackendPlugin {
  /** Stable id, also the URL segment: /api/v1/plugins/<id>/... */
  id: string;
  /** Mounted (auth-gated) under /api/v1/plugins/<id>. */
  routes: Hono;
  /** Tables/columns created for every install regardless of enablement. */
  migrations: PluginMigration[];
  /** Inert in OSS. An overlay may install a policy gate for it (see gate.ts). */
  feature?: string;
  /** On for installs that never explicitly toggled their plugin set. */
  defaultEnabled?: boolean;
}

const PLUGINS: BackendPlugin[] = [];

export function registerBackendPlugin(plugin: BackendPlugin): void {
  // Idempotent re-registration (HMR / repeated imports) replaces by id.
  const idx = PLUGINS.findIndex((p) => p.id === plugin.id);
  if (idx >= 0) PLUGINS.splice(idx, 1);
  PLUGINS.push(plugin);
}

export function getBackendPlugins(): BackendPlugin[] {
  return PLUGINS;
}

export function getBackendPlugin(id: string): BackendPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}
```

- [ ] **Step 4: Write the runner**

Create `packages/backend/src/plugins/runner.ts`:

```ts
// Applies every registered plugin's pending migrations to the current DB.
// Tracked in plugin_schema_migrations keyed by (plugin_id, version), evolving
// independently of core migrations. Tables are created for every install
// regardless of enablement, which keeps toggling instant. Must run after core
// runMigrations(). Safe to call repeatedly; only pending versions execute.

import type { Database } from "bun:sqlite";
import { getDb } from "../database/connection";
import { logger } from "../utils/logger";
import { getBackendPlugins } from "./registry";

export function runPluginMigrations(db?: Database): void {
  const plugins = getBackendPlugins();
  if (plugins.length === 0) return;

  const target = db ?? getDb();
  target.exec(`
    CREATE TABLE IF NOT EXISTS plugin_schema_migrations (
      plugin_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plugin_id, version)
    );
  `);

  for (const plugin of plugins) {
    const row = target
      .query("SELECT MAX(version) as v FROM plugin_schema_migrations WHERE plugin_id = ?")
      .get(plugin.id) as { v: number | null };
    const currentVersion = row.v ?? 0;
    const pending = plugin.migrations
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      target.transaction(() => {
        migration.up(target);
        target.run(
          "INSERT INTO plugin_schema_migrations (plugin_id, version, name) VALUES (?, ?, ?)",
          [plugin.id, migration.version, migration.name],
        );
      })();
      logger.info(
        { plugin: plugin.id, version: migration.version, name: migration.name },
        "Applied plugin migration",
      );
    }
  }
}
```

The optional `db` parameter exists so callers holding an explicit connection (tests, cloud tenant runner) can pass it; standalone boot calls it with no argument.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/backend/src/tests/plugin-framework.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
cd inkvoice && git add packages/backend/src/plugins packages/backend/src/tests/plugin-framework.test.ts
git commit -m "feat(plugins): backend plugin registry and migration runner"
```

---

### Task 2: Plugin enablement store

**Files:**
- Create: `packages/backend/src/plugins/settings.ts`
- Modify: `packages/backend/src/tests/plugin-framework.test.ts` (append a describe block)

**Interfaces:**
- Consumes: OSS `getSetting` / `updateSettings` from `../services/settings.service`, `getBackendPlugins` from `./registry`.
- Produces: `getEnabledPluginIds(): string[]`, `isPluginEnabled(id: string): boolean`, `setPluginEnabled(id: string, enabled: boolean): string[]`. Persisted in the OSS `settings` KV under the key `enabled_plugins` (JSON array of ids). Unset key + `defaultEnabled` plugins means on.

- [ ] **Step 1: Write the failing tests**

Append to `plugin-framework.test.ts`:

```ts
import { getEnabledPluginIds, setPluginEnabled } from "../plugins/settings";
import { registerBackendPlugin } from "../plugins/registry";

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
```

The `dummyPluginWithFlag` helper (define it next to `dummyPlugin` at the top of the file):

```ts
function dummyPluginWithFlag(id: string, defaultEnabled: boolean) {
  return { ...dummyPlugin(id), defaultEnabled };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/backend/src/tests/plugin-framework.test.ts`
Expected: FAIL, module `../plugins/settings` not found.

- [ ] **Step 3: Write the enablement service**

Create `packages/backend/src/plugins/settings.ts`:

```ts
// Per-install plugin enablement, persisted in the settings KV store under the
// enabled_plugins key (a JSON array of plugin ids). Enablement only gates
// access and UI. Plugin tables are migrated for every install regardless,
// which keeps migrations simple and toggling instant. In a multi-tenant
// overlay the OSS settings service is tenant-bound, so this stays per-tenant
// with no code changes.

import { getSetting, updateSettings } from "../services/settings.service";
import { getBackendPlugins } from "./registry";

const KEY = "enabled_plugins";

/**
 * Enabled plugin ids for the current install. When the key is unset (never
 * toggled anything), plugins flagged defaultEnabled are on.
 */
export function getEnabledPluginIds(): string[] {
  const raw = getSetting(KEY);
  if (raw === null) {
    return getBackendPlugins()
      .filter((p) => p.defaultEnabled)
      .map((p) => p.id);
  }
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function isPluginEnabled(id: string): boolean {
  return getEnabledPluginIds().includes(id);
}

/** Toggle a plugin; returns the new enabled-id set. */
export function setPluginEnabled(id: string, enabled: boolean): string[] {
  const current = new Set(getEnabledPluginIds());
  if (enabled) current.add(id);
  else current.delete(id);
  const ids = [...current];
  updateSettings({ [KEY]: JSON.stringify(ids) });
  return ids;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/backend/src/tests/plugin-framework.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/plugins/settings.ts packages/backend/src/tests/plugin-framework.test.ts
git commit -m "feat(plugins): enablement store on the settings KV"
```

---

### Task 3: Feature-gate hook, access gate, catalog API, createApp mounting

**Files:**
- Create: `packages/backend/src/plugins/feature-gate.ts`
- Create: `packages/backend/src/plugins/gate.ts`
- Create: `packages/backend/src/plugins/routes.ts`
- Create: `packages/backend/src/plugins/index.ts` (barrel, empty for now)
- Modify: `packages/backend/src/app.ts` (mount plugins after core routes)
- Test: append to `packages/backend/src/tests/plugin-framework.test.ts` (API tests need their own beforeAll app boot; see code below)

**Interfaces:**
- Consumes: registry (Task 1), enablement (Task 2), OSS `authMiddleware` already applied to `/api/v1/*` in `createApp`.
- Produces:
  - `type PluginFeatureGate = (feature: string) => (c: Context, next: Next) => Promise<void | Response>`
  - `setPluginFeatureGate(gate: PluginFeatureGate | null): void`, `getPluginFeatureGate(): PluginFeatureGate | null`
  - `pluginGate(plugin: BackendPlugin)` middleware
  - `pluginsAdminRoutes: Hono` (GET `/`, PUT `/:id`)
  - `runPluginMigrations` boot call wired into `packages/backend/src/index.ts`

- [ ] **Step 1: Write the feature-gate module**

Create `packages/backend/src/plugins/feature-gate.ts`:

```ts
// Injectable plan-feature policy. OSS ships no plans, so the default is a
// pass-through: plugins that declare `feature` behave as if ungated. An
// overlay (Inkvoice Cloud) installs its own policy at boot via
// setPluginFeatureGate, mapping a declared feature to plan middleware. OSS
// never imports overlay code.

import type { Context, Next } from "hono";

export type FeatureGateMiddleware = (c: Context, next: Next) => Promise<void | Response>;
export type PluginFeatureGate = (feature: string) => FeatureGateMiddleware;

let featureGate: PluginFeatureGate | null = null;

export function setPluginFeatureGate(gate: PluginFeatureGate | null): void {
  featureGate = gate;
}

export function getPluginFeatureGate(): PluginFeatureGate | null {
  return featureGate;
}
```

- [ ] **Step 2: Write the access gate**

Create `packages/backend/src/plugins/gate.ts`:

```ts
import type { Context, Next } from "hono";
import { getPluginFeatureGate } from "./feature-gate";
import type { BackendPlugin } from "./registry";
import { isPluginEnabled } from "./settings";

/**
 * Access gate for a plugin's routes, mounted at /api/v1/plugins/<id>/* after
 * the core auth middleware, so user context is already resolved. A disabled
 * plugin answers 404 (it should look non-existent). When the plugin declares a
 * plan feature and an overlay installed a policy gate, that gate runs too.
 */
export function pluginGate(plugin: BackendPlugin) {
  return async (c: Context, next: Next) => {
    if (!isPluginEnabled(plugin.id)) {
      return c.json({ success: false, error: "Plugin not enabled", plugin: plugin.id }, 404);
    }
    if (plugin.feature) {
      const gate = getPluginFeatureGate();
      if (gate) return gate(plugin.feature)(c, next);
    }
    await next();
  };
}
```

- [ ] **Step 3: Write the catalog routes**

Create `packages/backend/src/plugins/routes.ts`:

```ts
// Plugin management API, mounted at /api/v1/plugins (auth-gated by the core
// app). Lists the plugin catalog with this install's enabled state and lets an
// admin toggle plugins. Display metadata (name/description/icon) lives in the
// frontend plugin registry; the backend is the source of truth for enablement.
//
// API tokens: scoped tokens (non-empty scope list) are denied here by
// apiTokenScopeMiddleware because "plugins" is not an API scope resource.
// Unscoped tokens behave as their owner.

import { Hono } from "hono";
import { z } from "zod";
import { getBackendPlugin, getBackendPlugins } from "./registry";
import { getEnabledPluginIds, setPluginEnabled } from "./settings";

export const pluginsAdminRoutes = new Hono();

// GET /api/v1/plugins: catalog + this install's enabled ids.
pluginsAdminRoutes.get("/", (c) => {
  const enabled = getEnabledPluginIds();
  const plugins = getBackendPlugins().map((p) => ({
    id: p.id,
    feature: p.feature ?? null,
    enabled: enabled.includes(p.id),
  }));
  return c.json({ success: true, data: { plugins, enabled } });
});

const toggleSchema = z.object({ enabled: z.boolean() });

// PUT /api/v1/plugins/:id: enable/disable a plugin (admin only).
pluginsAdminRoutes.put("/:id", async (c) => {
  const user = c.get("user") as { is_admin?: boolean } | undefined;
  if (!user?.is_admin) return c.json({ success: false, error: "Forbidden" }, 403);

  const id = c.req.param("id");
  if (!getBackendPlugin(id)) {
    return c.json({ success: false, error: "Unknown plugin" }, 404);
  }

  const parsed = toggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  const enabled = setPluginEnabled(id, parsed.data.enabled);
  return c.json({ success: true, data: { enabled } });
});
```

- [ ] **Step 4: Write the (empty for now) barrel**

Create `packages/backend/src/plugins/index.ts`:

```ts
// Official OSS plugins. Side-effect imports register each plugin at module
// load. app.ts imports this barrel, so the registry is populated before
// runPluginMigrations() and route mounting run.

// (Official OSS plugins are added here as side-effect imports.)
```

- [ ] **Step 5: Write the API tests**

Extend the file-level boot so the whole file shares one app (this is the restructure the note after Task 1's tests anticipated). At file scope add:

```ts
import { createApp } from "../app";
import { seed } from "../database/seed";
import type { Hono } from "hono";

let app: Hono;
let token: string;
```

and inside the existing top-level `beforeAll`, after `runMigrations();`:

```ts
  await seed();
  app = createApp();

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "plugintestadminpass" }),
  });
  token = ((await res.json()) as any).data.token;
```

(`token` must be a file-scope `let token: string;` too; rename `res` to `loginRes` consistently or keep `res` for the login response, one of the two, and use it consistently. The login uses `ADMIN_PASS = "plugintestadminpass"` from the boot above.)

The catalog tests, inside a new describe reusing the file-scope `app` and `token`:

```ts
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
```

For this test, the top-level `beforeAll` must register the feature-declaring plugin BEFORE `app = createApp();` (mounting happens at boot):

```ts
registerBackendPlugin({ ...dummyPlugin("zeta"), feature: "zeta-feature" });
```

The file-level boot note: since bun test shares module state and one SQLite connection per file, there is ONE top-level `beforeAll` doing env + initDatabase + runMigrations + seed + createApp + admin login (exactly the tags.test.ts shape), with `app`, `token`, and `getDb()` shared by all describes. The catalog describe and the feature-gate test above consume those shared bindings; do not re-declare env in nested describes. The registry ids used by tests (`alpha`, `beta`, `gamma`, `delta`, `epsilon`, `zeta`) leak into other suites because bun test shares module state per run; they are harmless (disabled-by-default plugins 404 behind the gate, and zeta's empty router 404s too), but keep ids unique and never assert exact catalog contents in other suites.

- [ ] **Step 6: Wire mounting into app.ts**

In `packages/backend/src/app.ts`, add imports:

```ts
import { pluginGate } from "./plugins/gate";
import "./plugins"; // side-effect: registers official plugins
import { pluginsAdminRoutes } from "./plugins/routes";
import { getBackendPlugins } from "./plugins/registry";
```

After the line `app.route("/api/v1/tags", tags);` and before `return app;`, insert:

```ts
  // Official plugins. Mounted after core auth (registered above), each behind
  // its per-install enablement gate; the management API lists the catalog and
  // toggles plugins (admin only for writes). Overlays register extra plugins
  // into the same registry at import time, so they mount here too.
  app.route("/api/v1/plugins", pluginsAdminRoutes);
  for (const plugin of getBackendPlugins()) {
    app.use(`/api/v1/plugins/${plugin.id}/*`, pluginGate(plugin));
    app.route(`/api/v1/plugins/${plugin.id}`, plugin.routes);
  }
```

- [ ] **Step 7: Wire the runner into standalone boot**

In `packages/backend/src/index.ts`, add to the imports:

```ts
import { runPluginMigrations } from "./plugins/runner";
```

and in the `if (import.meta.main)` boot block, between `runMigrations()` and `await seed()`:

```ts
runPluginMigrations();
```

- [ ] **Step 8: Run tests**

Run: `bun test packages/backend/src/tests/plugin-framework.test.ts`
Expected: PASS

- [ ] **Step 9: Full backend suite still green**

Run: `bun test packages/backend/src/tests/`
Expected: all pass (the framework plugin ids leak harmlessly into other suites; they are disabled by default so their routes 404).

- [ ] **Step 10: Commit**

```bash
git add packages/backend/src/plugins packages/backend/src/app.ts packages/backend/src/index.ts packages/backend/src/tests/plugin-framework.test.ts
git commit -m "feat(plugins): catalog api, access gate, and createApp mounting"
```

---

### Task 4: Time-tracker plugin backend (migrations + service with ownership scoping)

**Files:**
- Create: `packages/backend/src/plugins/time-tracker/migrations.ts`
- Create: `packages/backend/src/plugins/time-tracker/service.ts`
- Create: `packages/backend/src/plugins/index.ts` (add barrel import)
- Test: create `packages/backend/src/tests/time-tracker.test.ts`

**Interfaces:**
- Consumes: `registerBackendPlugin` from `../registry`, OSS `getDb()` from `@/database/connection` (relative `../../database/connection`), OSS `createInvoice` from `../../services/invoice.service`, `requirePermission` from `../../middleware/auth` (Task 5).
- Produces (used by Task 5 routes):
  - `interface Actor { userId: string; isAdmin: boolean }`
  - `listProjects(includeArchived?): TtProject[]`, `getProject(id)`, `createProject(input)`, `updateProject(id, input)`, `deleteProject(id)`
  - `listEntries(actor: Actor, filters?): TtTimeEntryWithProject[]`, `getEntry(id)`, `createEntry(userId, input)`, `updateEntry(actor: Actor, id, input): TtTimeEntry | null`, `deleteEntry(actor: Actor, id): boolean`
  - `getActiveTimer(userId)`, `startTimer(userId, input)`, `stopTimer(userId)`
  - `getSummary(actor: Actor, filters?): SummaryRow[]`
  - `createInvoiceFromUnbilled(input): InvoiceFromTimeResult | null`
  - `type TimeEntryEditGuard = (input: { entry: TtTimeEntry; actor: Actor }) => string | null`
  - `setTimeEntryEditGuard(fn: TimeEntryEditGuard | null): void`

Porting source: `/Users/baris/projects/inhouse/inkvoice-mono/inkvoice-cloud/packages/backend/src/cloud/plugins/time-tracker/` (migrations.ts, service.ts). Copy from there and apply the changes below. Drop the cloud copyright headers; OSS is MIT with no header comments in its sources.

- [ ] **Step 1: Port migrations byte-identical**

Create `packages/backend/src/plugins/time-tracker/migrations.ts` by copying the cloud file and changing only the import path comment. Exact content:

```ts
import type { PluginMigration } from "../registry";

// Time Tracker schema. Tracked in plugin_schema_migrations under
// plugin_id = "time-tracker", evolving independently of core migrations.
// Byte-identical to the version that shipped in Inkvoice Cloud so existing
// tenant databases continue without a data migration.
export const timeTrackerMigrations: PluginMigration[] = [
  {
    version: 1,
    name: "time_tracker_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tt_projects (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          name TEXT NOT NULL,
          customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
          default_rate REAL,
          billable INTEGER NOT NULL DEFAULT 1,
          color TEXT,
          is_archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tt_time_entries (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          project_id TEXT NOT NULL REFERENCES tt_projects(id) ON DELETE CASCADE,
          description TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_seconds INTEGER,
          rate REAL,
          billable INTEGER NOT NULL DEFAULT 1,
          is_billed INTEGER NOT NULL DEFAULT 0,
          invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
          user_id TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_tt_entries_project ON tt_time_entries(project_id);
        CREATE INDEX IF NOT EXISTS idx_tt_entries_user ON tt_time_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_tt_entries_billed ON tt_time_entries(is_billed);
        CREATE INDEX IF NOT EXISTS idx_tt_projects_customer ON tt_projects(customer_id);
      `);
    },
  },
];
```

- [ ] **Step 2: Write the service with ownership scoping**

Create `packages/backend/src/plugins/time-tracker/service.ts` as a port of the cloud `service.ts` (482 lines) with exactly these changes. Read the cloud file and keep everything not listed here byte-identical (including the doc comments, minus the cloud license header which becomes a plain description line):

```ts
// Time Tracker business logic. Direct SQL against the (tenant-bound) DB,
// mirroring OSS service conventions: prepared statements, plain SQL, no ORM.
// Entry data is user-owned: non-admins may only see and modify their own
// entries. Projects are shared team objects; mutations are admin-only at the
// route layer.
```

1. Add after the imports:

```ts
import { getDb } from "../../database/connection";
import { createInvoice } from "../../services/invoice.service";
import type { InvoiceWithItems } from "../../types/invoice";

export interface Actor {
  userId: string;
  isAdmin: boolean;
}

// --- Edit guard (extension seam) --------------------------------------------

export interface TimeEntryEditGuardInput {
  entry: TtTimeEntry;
  actor: Actor;
}

/**
 * Optional guard consulted before any entry mutation. Returns an error message
 * to reject the edit, or null to allow. Overlays (e.g. cloud timesheet
 * approvals) install a guard via setTimeEntryEditGuard; OSS default allows all.
 */
export type TimeEntryEditGuard = (input: TimeEntryEditGuardInput) => string | null;

let editGuard: TimeEntryEditGuard | null = null;

export function setTimeEntryEditGuard(guard: TimeEntryEditGuard | null): void {
  editGuard = guard;
}

function assertEditAllowed(entry: TtTimeEntry, actor: Actor): void {
  if (editGuard) {
    const error = editGuard({ entry, actor });
    if (error) throw new Error(error);
  }
}
```

2. `listEntries` gains an actor first parameter and forced scoping:

```ts
export function listEntries(actor: Actor, filters: EntryFilters = {}): TtTimeEntryWithProject[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  // Non-admins are hard-scoped to their own entries; admins may filter by user.
  if (!actor.isAdmin) {
    conditions.push("e.user_id = ?");
    params.push(actor.userId);
  } else if (filters.user_id) {
    conditions.push("e.user_id = ?");
    params.push(filters.user_id);
  }
  if (filters.project_id) {
    conditions.push("e.project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.billed !== undefined) {
    conditions.push("e.is_billed = ?");
    params.push(filters.billed ? 1 : 0);
  }
  if (filters.from) {
    conditions.push("e.started_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("e.started_at <= ?");
    params.push(filters.to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .query(
      `SELECT e.*, p.name as project_name
         FROM tt_time_entries e JOIN tt_projects p ON e.project_id = p.id
         ${where}
         ORDER BY e.started_at DESC`,
    )
    .all(...params) as TtTimeEntryWithProject[];
}
```

and `EntryFilters` gains `user_id?: string;`.

3. `getSummary` takes the actor and adds the same scoping lines inside its `conditions`/`params` construction (before the existing project/from/to conditions):

```ts
export function getSummary(actor: Actor, filters: EntryFilters = {}): SummaryRow[] {
  const db = getDb();
  const conditions: string[] = ["e.duration_seconds IS NOT NULL"];
  const params: (string | number)[] = [];
  if (!actor.isAdmin) {
    conditions.push("e.user_id = ?");
    params.push(actor.userId);
  }
  // ... rest identical to the cloud version
```

4. `updateEntry` and `deleteEntry` take the actor, enforce ownership, and run the guard:

```ts
export function updateEntry(actor: Actor, id: string, input: EntryUpdateInput): TtTimeEntry | null {
  const existing = getEntry(id);
  if (!existing) return null;
  if (!actor.isAdmin && existing.user_id !== actor.userId) return null;
  const blocked = editGuard?.({ entry: existing, actor });
  if (blocked) throw new Error(blocked);
  // ... body identical to the cloud version from here
}

export function deleteEntry(actor: Actor, id: string): boolean {
  const existing = getEntry(id);
  if (!existing) return false;
  if (!actor.isAdmin && existing.user_id !== actor.userId) return false;
  const blocked = editGuard?.({ entry: existing, actor });
  if (blocked) throw new Error(blocked);
  const db = getDb();
  const res = db.run("DELETE FROM tt_time_entries WHERE id = ?", [id]);
  return res.changes > 0;
}
```

5. Unchanged verbatim: `TtProject`/`TtTimeEntry` interfaces, `listProjects`, `ProjectInput`, `createProject`, `getProject`, `updateProject`, `deleteProject`, `getEntry`, `normalizeDuration`, `createEntry`, `EntryUpdateInput`, `getActiveTimer`, `TimerStartInput`, `startTimer`, `stopTimer`, `SummaryRow`, `InvoiceFromTimeInput`, `InvoiceFromTimeResult`, `createInvoiceFromUnbilled`. Fix imports at the top of the file to the OSS paths shown in change 1 and drop the cloud license header lines.

- [ ] **Step 3: Write the service-level tests**

This is a port of existing, already-tested logic, so the tests are written after the module they import (they import `../plugins/time-tracker/service`, which does not exist until Step 2). Create `packages/backend/src/tests/time-tracker.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import "../plugins"; // registers time-tracker so its migrations run
import { runPluginMigrations } from "../plugins/runner";
import {
  createEntry,
  createProject,
  deleteEntry,
  deleteProject,
  listEntries,
  listProjects,
  setTimeEntryEditGuard,
  startTimer,
  stopTimer,
  updateEntry,
  updateProject,
  type Actor,
} from "../plugins/time-tracker/service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-time-tracker.db";

const admin: Actor = { userId: "admin-user-1", isAdmin: true };
const alice: Actor = { userId: "alice-user-2", isAdmin: false };
const bob: Actor = { userId: "bob-user-3", isAdmin: false };

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "tttestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

function secondsAgo(s: number): string {
  return new Date(Date.now() - s * 1000).toISOString();
}

describe("time-tracker projects", () => {
  test("create, list, update, archive", () => {
    const p = createProject({ name: "Website", default_rate: 100, billable: true });
    expect(p.name).toBe("Website");
    expect(listProjects(false).some((x) => x.id === p.id)).toBe(true);
    const updated = updateProject(p.id, { name: "Website v2", is_archived: true });
    expect(updated?.name).toBe("Website v2");
    expect(updated?.is_archived).toBe(1);
    expect(listProjects(false).some((x) => x.id === p.id)).toBe(false);
    expect(listProjects(true).some((x) => x.id === p.id)).toBe(true);
    expect(deleteProject(p.id)).toBe(true);
  });
});

describe("time-tracker entries and timer", () => {
  let projectId: string;

  beforeAll(() => {
    projectId = createProject({ name: "Entries Test", default_rate: 50 }).id;
  });

  test("manual entry normalizes duration from ended_at", () => {
    const e = createEntry(alice.userId, {
      project_id: projectId,
      started_at: secondsAgo(3600),
      ended_at: secondsAgo(1800),
    });
    expect(e.duration_seconds).toBe(1800);
    expect(e.user_id).toBe(alice.userId);
  });

  test("timer start/stop rounds are per user", () => {
    const t = startTimer(alice.userId, { project_id: projectId });
    expect(t.ended_at).toBeNull();
    expect(startTimer(bob.userId, { project_id: projectId })).toBeTruthy();
    const stopped = stopTimer(alice.userId);
    expect(stopped?.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(stopTimer(bob.userId)?.ended_at).not.toBeNull();
  });

  test("non-admin lists and edits only own entries", () => {
    const mine = createEntry(alice.userId, {
      project_id: projectId,
      started_at: secondsAgo(600),
      duration_seconds: 600,
      description: "alice work",
    });
    const bobEntry = createEntry(bob.userId, {
      project_id: projectId,
      started_at: secondsAgo(300),
      description: "bob work",
    });

    const aliceList = listEntries(alice);
    expect(aliceList.some((e) => e.id === mine.id)).toBe(true);
    expect(aliceList.some((e) => e.id === bobEntry.id)).toBe(false);

    expect(updateEntry(bob, mine.id, { description: "hacked" })).toBeNull();
    expect(deleteEntry(bob, mine.id)).toBe(false);

    const adminList = listEntries(admin);
    expect(adminList.some((e) => e.id === mine.id)).toBe(true);
    expect(adminList.some((e) => e.id === bobEntry.id)).toBe(true);

    expect(updateEntry(admin, mine.id, { description: "admin edit" })?.description).toBe(
      "admin edit",
    );
    expect(deleteEntry(admin, mine.id)).toBe(true);
    deleteEntry(admin, bobEntry.id);
  });
});

describe("time-tracker edit guard", () => {
  test("setTimeEntryEditGuard blocks update and delete", () => {
    const projectId = createProject({ name: "Guard Test" }).id;
    const entry = createEntry(alice.userId, { project_id: projectId, started_at: secondsAgo(600), duration_seconds: 60 });

    setTimeEntryEditGuard(({ entry: e }) => (e.is_billed ? "locked" : null));
    try {
      expect(() => updateEntry(alice, entry.id, { description: "x" })).toThrow("locked");
    } finally {
      setTimeEntryEditGuard(null);
    }
    expect(updateEntry(alice, entry.id, { description: "ok" })?.description).toBe("ok");
  });
});
```

Notes for the implementer:
- The test file is a complete sketch, not verbatim: reconcile imports and actor consts (`admin`, `alice`, `bob` as `Actor` values, i.e. `{ userId: string; isAdmin: boolean }`) at the top of the file; every symbol used below is exported by the service from Step 2.
- `startTimer` throws when a timer is already running for the same user; the test starts two timers for different users, which is allowed.
- The service suite boots its own DB file `./data/test-time-tracker.db` with the tags.test.ts env pattern.

- [ ] **Step 4: Run the service tests**

Run: `bun test packages/backend/src/tests/time-tracker.test.ts`
Expected: PASS (service and tests land in the same task; if a test fails, fix the service, not the assertion, unless the assertion itself encodes the wrong contract).

Also make sure the Task 4 imports in the test file compile: `updateProject` and `deleteProject` must be imported from the service (the projects describe uses them).

- [ ] **Step 5: Add time-tracker to the OSS barrel**

Update `packages/backend/src/plugins/index.ts`:

```ts
// Official OSS plugins. Side-effect imports register each plugin at module
// load. app.ts imports this barrel so the registry is populated before
// runPluginMigrations() and route mounting.

import "./time-tracker";
```

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/plugins/time-tracker packages/backend/src/plugins/index.ts packages/backend/src/tests/time-tracker.test.ts
git commit -m "feat(plugins): time-tracker plugin backend with ownership scoping"
```

---

### Task 5: Time-tracker routes (admin guards, permission-gated billing) + API integration tests

**Files:**
- Create: `packages/backend/src/plugins/time-tracker/index.ts`
- Modify: `packages/backend/src/tests/time-tracker.test.ts` (append API describe)

**Interfaces:**
- Consumes: service functions from Task 4 (`svc.*`), `registerBackendPlugin` from `../registry`, `timeTrackerMigrations`, OSS `requirePermission` from `../../middleware/auth`.
- Produces: plugin `id: "time-tracker"` mounted at `/api/v1/plugins/time-tracker` with routes `/projects` (GET all, POST/PUT/DELETE admin-only), `/entries` (GET scoped, POST any user), `/entries/:id` (PUT/DELETE owner-or-admin), `/timer/active|start|stop`, `/summary`, `/invoice` (requires `invoices:create`).

- [ ] **Step 1: Write the plugin routes**

Create `packages/backend/src/plugins/time-tracker/index.ts` (full file):

```ts
// Time Tracker plugin: projects, per-user time entries and timer, summaries,
// and invoice-from-unbilled-time. Mounted at /api/v1/plugins/time-tracker.
// Ownership model: non-admins see and manage only their own entries; projects
// are shared read, admin-only write; billing time into an invoice requires the
// core invoices:create permission.

import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/auth";
import { registerBackendPlugin } from "../registry";
import { timeTrackerMigrations } from "./migrations";
import * as svc from "./service";

const routes = new Hono();

const ok = (data: unknown) => ({ success: true as const, data });

interface RequestUser {
  sub: string;
  is_admin: boolean;
}

function actor(c: { get: (k: string) => unknown }): svc.Actor {
  const user = c.get("user") as { sub: string; is_admin: boolean } | undefined;
  return { userId: user?.sub ?? "", isAdmin: !!user?.is_admin };
}

function isAdmin(c: { get: (k: string) => unknown }): boolean {
  return !!(c.get("user") as { is_admin?: boolean } | undefined)?.is_admin;
}

// --- Projects ---------------------------------------------------------------

const projectSchema = z.object({
  name: z.string().min(1),
  customer_id: z.string().nullable().optional(),
  default_rate: z.number().nonnegative().nullable().optional(),
  billable: z.boolean().optional(),
  color: z.string().nullable().optional(),
  is_archived: z.boolean().optional(),
});

routes.get("/projects", (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  return c.json(ok(svc.listProjects(includeArchived)));
});

routes.post("/projects", async (c) => {
  if (!isAdmin(c)) return c.json({ success: false, error: "Forbidden" }, 403);
  const parsed = projectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid project" }, 400);
  return c.json(ok(svc.createProject(parsed.data)), 201);
});

routes.put("/projects/:id", async (c) => {
  if (!isAdmin(c)) return c.json({ success: false, error: "Forbidden" }, 403);
  const parsed = projectSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid project" }, 400);
  const updated = svc.updateProject(c.req.param("id"), parsed.data as svc.ProjectInput);
  if (!updated) return c.json({ success: false, error: "Project not found" }, 404);
  return c.json(ok(updated));
});

routes.delete("/projects/:id", (c) => {
  if (!isAdmin(c)) return c.json({ success: false, error: "Forbidden" }, 403);
  const removed = svc.deleteProject(c.req.param("id"));
  if (!removed) return c.json({ success: false, error: "Project not found" }, 404);
  return c.json(ok({ id: c.req.param("id") }));
});

// --- Entries ----------------------------------------------------------------

const entrySchema = z.object({
  project_id: z.string().min(1),
  description: z.string().nullable().optional(),
  started_at: z.string().min(1),
  ended_at: z.string().nullable().optional(),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  rate: z.number().nonnegative().nullable().optional(),
  billable: z.boolean().optional(),
});

routes.get("/entries", (c) => {
  const billedParam = c.req.query("billed");
  const act = actor(c);
  const userIdFilter = isAdmin(c) ? c.req.query("user_id") || undefined : undefined;
  return c.json(
    ok(
      svc.listEntries(act, {
        user_id: userIdFilter,
        project_id: c.req.query("project_id") || undefined,
        billed: billedParam === undefined ? undefined : billedParam === "true",
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
      }),
    ),
  );
});

routes.post("/entries", async (c) => {
  const parsed = entrySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid entry" }, 400);
  try {
    return c.json(ok(svc.createEntry(actor(c).userId, parsed.data)), 201);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400);
  }
});

routes.put("/entries/:id", async (c) => {
  const parsed = entrySchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid entry" }, 400);
  try {
    const updated = svc.updateEntry(actor(c), c.req.param("id"), parsed.data as svc.EntryUpdateInput);
    if (!updated) return c.json({ success: false, error: "Entry not found" }, 404);
    return c.json(ok(updated));
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 409);
  }
});

routes.delete("/entries/:id", (c) => {
  try {
    const removed = svc.deleteEntry(actor(c), c.req.param("id"));
    if (!removed) return c.json({ success: false, error: "Entry not found" }, 404);
    return c.json(ok({ id: c.req.param("id") }));
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 409);
  }
});

// --- Timer ------------------------------------------------------------------

const timerStartSchema = z.object({
  project_id: z.string().min(1),
  description: z.string().nullable().optional(),
  rate: z.number().nonnegative().nullable().optional(),
});

routes.get("/timer/active", (c) => c.json(ok(svc.getActiveTimer(actor(c).userId))));

routes.post("/timer/start", async (c) => {
  const parsed = timerStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid timer" }, 400);
  try {
    return c.json(ok(svc.startTimer(actor(c).userId, parsed.data)), 201);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 409);
  }
});

routes.post("/timer/stop", (c) => {
  const stopped = svc.stopTimer(actor(c).userId);
  if (!stopped) return c.json({ success: false, error: "No running timer" }, 404);
  return c.json(ok(stopped));
});

// --- Summary ----------------------------------------------------------------

routes.get("/summary", (c) =>
  c.json(
    ok(
      svc.getSummary(actor(c), {
        project_id: c.req.query("project_id") || undefined,
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
      }),
    ),
  ),
);

// --- Invoice from unbilled time ---------------------------------------------

const invoiceSchema = z.object({
  customer_id: z.string().min(1),
  project_id: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  issue_date: z.string().optional(),
});

routes.post("/invoice", requirePermission("invoices", "create"), async (c) => {
  const parsed = invoiceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid request" }, 400);
  const result = svc.createInvoiceFromUnbilled(parsed.data);
  if (!result) return c.json({ success: false, error: "No unbilled time for customer" }, 400);
  return c.json(ok(result), 201);
});

registerBackendPlugin({
  id: "time-tracker",
  routes,
  migrations: timeTrackerMigrations,
  defaultEnabled: true,
});
```

(As shown in the full file above, `ok` is defined once at the top of `index.ts` and the entries GET defines `const act = actor(c)` and `const userIdFilter = isAdmin(c) ? c.req.query("user_id") || undefined : undefined;` then passes `user_id: userIdFilter` into `svc.listEntries(act, {...})`.)

- [ ] **Step 2: Append API integration tests**

Append to `packages/backend/src/tests/time-tracker.test.ts` an API describe modeled on `permissions.test.ts` (admin + non-admin login). It can live in the same file since it boots its own app; add a second describe block with its own beforeAll that creates the app and both tokens:

Structure `time-tracker.test.ts` with ONE file-level boot (exactly the tags.test.ts shape): a top-level beforeAll sets env (`DATABASE_PATH = "./data/test-time-tracker.db"`, `ADMIN_USER = "admin"`, `ADMIN_PASS = "tttestadminpass"`, `JWT_SECRET`, `RATE_LIMIT_ENABLED=false`), `resetEnvCache()`, `initDatabase()`, `runMigrations()`, `runPluginMigrations()`, `await seed()`, `app = createApp()`, and logs in the admin. Then the API describe only adds the non-admin user and token:

```ts
describe("time-tracker api", () => {
  let userToken: string;

  beforeAll(async () => {
    const hash = await bcrypt.hash("tttestuserpass", 10);
    getDb().run(
      "INSERT INTO users (id, username, password_hash, is_admin, is_active) VALUES (?, ?, ?, 0, 1)",
      [crypto.randomBytes(16).toString("hex"), "tt_regular", hash],
    );
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tt_regular", password: "tttestuserpass" }),
    });
    userToken = ((await res.json()) as any).data.token as string;
  });
```

Then a request helper parameterized by token (same shape as `permissions.test.ts`'s `authedRequest`):

```ts
  function authed(token: string, path: string, opts: RequestInit = {}) {
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
```

Tests (capture the non-admin's id at insert time so assertions stay strict):

```ts
  test("project create is admin-only", async () => {
    const asUser = await authed(userToken, "/api/v1/plugins/time-tracker/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(asUser.status).toBe(403);

    const asAdmin = await authed(adminToken, "/api/v1/plugins/time-tracker/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Admin Project" }),
    });
    expect(asAdmin.status).toBe(201);
  });

  test("project list is readable by non-admins", async () => {
    const res = await authed(userToken, "/api/v1/plugins/time-tracker/projects");
    expect(res.status).toBe(200);
  });

  test("entries are self-scoped for non-admins over the API", async () => {
    const projects = (await (
      await authed(adminToken, "/api/v1/plugins/time-tracker/projects")
    ).json()) as any;
    const projectId = projects.data[0].id;

    await authed(userToken, "/api/v1/plugins/time-tracker/entries", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId,
        started_at: new Date().toISOString(),
        duration_seconds: 120,
      }),
    });

    const me = (await (await authed(userToken, "/api/v1/auth/me")).json()) as any;
    const myUserId = me.data.id as string;

    const list = (await (
      await authed(userToken, "/api/v1/plugins/time-tracker/entries")
    ).json()) as any;
    expect(list.data.length).toBeGreaterThan(0);
    for (const e of list.data) expect(e.user_id).toBe(myUserId);
  });

  test("invoice from time requires invoices:create", async () => {
    const res = await authed(userToken, "/api/v1/plugins/time-tracker/invoice", {
      method: "POST",
      body: JSON.stringify({ customer_id: "0000" }),
    });
    expect(res.status).toBe(403);
  });

  test("timer endpoints are per-user", async () => {
    const projects = (await (
      await authed(adminToken, "/api/v1/plugins/time-tracker/projects")
    ).json()) as any;
    const projectId = projects.data[0].id;

    const start = await authed(userToken, "/api/v1/plugins/time-tracker/timer/start", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId }),
    });
    expect(start.status).toBe(201);
    const stop = await authed(userToken, "/api/v1/plugins/time-tracker/timer/stop", {
      method: "POST",
    });
    expect(stop.status).toBe(200);
  });
```

(`adminToken` comes from the file-level boot; `admin` is the seeded admin from `ADMIN_PASS = "tttestadminpass"`.)

- [ ] **Step 3: Run the tests**

Run: `bun test packages/backend/src/tests/time-tracker.test.ts`
Expected: PASS (service + API describes)

- [ ] **Step 4: Full check**

Run: `cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice && bun run check`
Expected: lint, typecheck, and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/plugins/time-tracker packages/backend/src/tests/time-tracker.test.ts
git commit -m "feat(plugins): time-tracker routes with admin and invoice-permission guards"
```





---

### Task 6: Demo seed for time tracking

**Files:**
- Modify: `packages/backend/src/database/seed.ts` (extend `seedDemoData()`)
- Test: extend `packages/backend/src/tests/demo-seed.test.ts`

**Interfaces:**
- Consumes: `tt_projects` / `tt_time_entries` tables exist by the time `seedDemoDataIfEmpty()` runs (guaranteed by the boot order from Task 3 Step 4: `runMigrations()` then `runPluginMigrations()` then `seed()`).
- Produces: demo projects + entries on empty demo databases; nothing else changes.

- [ ] **Step 1: Write the failing test**

Append to `packages/backend/src/tests/demo-seed.test.ts` (the file already has a `bootFresh(demo)` helper and table-count helpers; follow its style):

```ts
test("demo seed creates time tracking data", async () => {
  await bootFresh(true);
  const db = getDb();
  const projects = (db.query("SELECT COUNT(*) as count FROM tt_projects").get() as { count: number }).count;
  const entries = (db.query("SELECT COUNT(*) as count FROM tt_time_entries").get() as { count: number }).count;
  const running = (db.query("SELECT COUNT(*) as count FROM tt_time_entries WHERE ended_at IS NULL").get() as { count: number }).count;
  expect(projects).toBeGreaterThanOrEqual(2);
  expect(entries).toBeGreaterThanOrEqual(15);
  expect(running).toBe(0);
});
```

Also update the existing `bootFresh` helper in that file to mirror the new standalone boot order, by adding the plugin migration call and barrel import:

```ts
import "../plugins"; // registers official plugins so their migrations exist
import { runPluginMigrations } from "../plugins/runner";
```

and inside `bootFresh`, after `runMigrations();`:

```ts
runPluginMigrations();
```

The non-demo test in that file (`bootFresh(false)`) must also keep passing; plugin migrations run for every install regardless of demo mode, and seed only writes time rows in demo mode.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/backend/src/tests/demo-seed.test.ts`
Expected: FAIL (no tt_ rows seeded yet).

- [ ] **Step 3: Implement the seed**

In `packages/backend/src/database/seed.ts`, inside `seedDemoData()` (after the invoice seeding loop, before the function ends), add:

```ts
  // Demo time tracking: 2 projects, ~15 unbilled entries over the last 2 weeks.
  const demoProjects = [
    { name: "Acme Corp Retainer", customerIndex: 0, default_rate: 150, billable: 1 },
    { name: "Internal R&D", customerIndex: null, default_rate: null, billable: 0 },
  ];
  const demoProjectIds: string[] = demoProjects.map((p) => {
    const id = crypto.randomBytes(16).toString("hex");
    db.run(
      `INSERT INTO tt_projects (id, name, customer_id, default_rate, billable)
       VALUES (?, ?, ?, ?, ?)`,
      [id, p.name, p.customerIndex === null ? null : customerIds[p.customerIndex], p.default_rate, p.billable],
    );
    return id;
  });

  const adminId = (
    db.query("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as { id: string }
  ).id;

  for (let i = 0; i < 15; i++) {
    const entryId = crypto.randomBytes(16).toString("hex");
    const projectIndex = i % demoProjects.length;
    const projectId = demoProjectIds[projectIndex];
    const project = demoProjects[projectIndex];
    const dayOffset = Math.floor(i / 2) + 1; // entries over the last ~8 days
    const startedAt = new Date();
    startedAt.setDate(startedAt.getDate() - dayOffset);
    startedAt.setHours(9 + (i % 6), 0, 0, 0);
    const durationSeconds = 1800 + seededValue(i, 8) * 900; // 45min to ~2.5h
    const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
    db.run(
      `INSERT INTO tt_time_entries
         (id, project_id, description, started_at, ended_at, duration_seconds, rate, billable, is_billed, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        entryId,
        projectId,
        i % 3 === 0 ? "Implementation" : i % 3 === 1 ? "Review and planning" : "Support",
        startedAt.toISOString(),
        endedAt.toISOString(),
        durationSeconds,
        null,
        project.billable,
        adminId,
      ],
    );
  }
```

Notes:
- `seededValue(i, max)` already exists earlier in `seedDemoData()`; reuse it, do not redeclare.
- `customerIds` is the array built earlier in `seedDemoData()` (index 0 is Acme Corp).
- `rate` is inserted as `null` so billing falls back to the project default rate; `is_billed` is `0` so the demo shows the unbilled flows.
- The column list has 10 columns and the VALUES list must match 1:1: id, project_id, description, started_at, ended_at, duration_seconds, rate(null), billable, is_billed(0), user_id.

- [ ] **Step 4: Run tests**

Run: `bun test packages/backend/src/tests/demo-seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/database/seed.ts packages/backend/src/tests/demo-seed.test.ts
git commit -m "feat(plugins): seed demo time-tracking data in demo mode"
```

---

### Task 7: Frontend plugin framework port

**Files:**
- Create: `packages/frontend/src/plugins/api.ts`, `registry.ts`, `use-plugins.store.ts`, `PluginGuard.tsx`, `install-nav-gate.ts`, `PluginsSettingsTab.tsx`, `i18n.ts`, `index.tsx`
- Modify: `packages/frontend/src/registrations.tsx`
- Test: `packages/frontend/src/tests/plugins-bootstrap.test.ts`

**Interfaces:**
- Consumes: OSS registries `@/route-registry`, `@/nav-registry`, `@/pages/settings-tab-registry`, `@/i18n` (`registerTranslations`), `getAuthToken` from `@/api/client` (exists at `packages/frontend/src/api/client.ts:11`).
- Produces (consumed by Task 8 and by the cloud overlay in Phase B):
  - `pluginFetch<T>(path: string, options?: RequestInit): Promise<T>` from `./plugins/api`
  - `registerPlugin(p: FrontendPlugin): void`, `getPlugins(): FrontendPlugin[]` from `./plugins/registry`
  - `usePluginsStore` with `enabled, loaded, loading, error, ensureFetched, refresh, isEnabled, setEnabled`
  - `PluginGuard({ pluginId, children })`
  - `installPluginNavGate(): void`
  - Barrel `@/plugins` exporting nothing; side effects only.

Port source: `/Users/baris/projects/inhouse/inkvoice-mono/inkvoice-cloud/packages/frontend/src/plugins/`. Copy these files verbatim (no changes needed; they only import from `@/` and relative paths that resolve identically in OSS): `api.ts`, `registry.ts`, `use-plugins.store.ts`, `PluginGuard.tsx`, `install-nav-gate.ts`, `PluginsSettingsTab.tsx`, `i18n.ts`. Keep their existing comments.

- [ ] **Step 1: Copy the framework files**

```bash
mkdir -p inkvoice/packages/frontend/src/plugins inkvoice/packages/frontend/src/tests
cp inkvoice-cloud/packages/frontend/src/plugins/api.ts            inkvoice/packages/frontend/src/plugins/api.ts
cp inkvoice-cloud/packages/frontend/src/plugins/registry.ts       inkvoice/packages/frontend/src/plugins/registry.ts
cp inkvoice-cloud/packages/frontend/src/plugins/use-plugins.store.ts inkvoice/packages/frontend/src/plugins/use-plugins.store.ts
cp inkvoice-cloud/packages/frontend/src/plugins/PluginGuard.tsx   inkvoice/packages/frontend/src/plugins/PluginGuard.tsx
cp inkvoice-cloud/packages/frontend/src/plugins/install-nav-gate.ts inkvoice/packages/frontend/src/plugins/install-nav-gate.ts
cp inkvoice-cloud/packages/frontend/src/plugins/PluginsSettingsTab.tsx inkvoice/packages/frontend/src/plugins/PluginsSettingsTab.tsx
cp inkvoice-cloud/packages/frontend/src/plugins/i18n.ts           inkvoice/packages/frontend/src/plugins/i18n.ts
```

Verify after copying: `PluginsSettingsTab.tsx` and `api.ts` import `sonner`, `zustand`, `@/api/client`, `@/components/ui/*`, `@/i18n`, all of which exist in OSS frontend (check `packages/frontend/package.json` has `sonner` and `zustand`; if `sonner` is missing, stop and use the existing toast mechanism in OSS instead, checking how `lib/format-api-error.ts` consumers surface errors).

- [ ] **Step 2: Write the failing bootstrap test**

Create `packages/frontend/src/tests/plugins-bootstrap.test.ts`:

```ts
// Bootstrap smoke test: importing the plugins barrel must register the
// framework's settings tab and (after Task 8) the time-tracker surface into
// the OSS extension points. Mirrors cloud's cloud-bootstrap.test.ts.

import { describe, expect, test } from "bun:test";
import { getNavItems } from "@/nav-registry";
import { getRoutes } from "@/route-registry";
import { getSettingsTabs } from "@/pages/settings-tab-registry";
import "@/plugins";

const protectedPaths = getRoutes("protected").map((r) => r.path);
const settingsTabIds = getSettingsTabs().map((t) => t.id);

describe("oss plugin bootstrap", () => {
  test("registers the Plugins settings tab", () => {
    expect(settingsTabIds).toContain("plugins");
  });

  test("installs the nav gate without breaking core nav", () => {
    // useNavGate must be callable; the allow-all default is replaced by the
    // plugin gate at bootstrap. We assert the registry is intact.
    expect(Array.isArray(getNavItems())).toBe(true);
  });
});
```

(When Task 8 lands, extend this file with the time-tracker assertions shown there instead of adding a new file.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice && bun test packages/frontend/src/tests/plugins-bootstrap.test.ts`
Expected: FAIL (barrel does not exist yet).

- [ ] **Step 4: Write the barrel and wire it into the OSS bootstrap**

Create `packages/frontend/src/plugins/index.tsx`:

```tsx
// Frontend plugin framework barrel. Imported by @/registrations at bootstrap
// (before <App> renders). Installs the nav gate, registers the admin Plugins
// settings tab, and side-effect-imports each official plugin's frontend
// module (which registers its own nav item, route, i18n, and registry
// metadata).
//
// To add a plugin: create plugins/<id>/index.tsx and add a side-effect import.

import { registerSettingsTab } from "@/pages/settings-tab-registry";
import "./i18n";
import { installPluginNavGate } from "./install-nav-gate";
import { PluginsSettingsTab } from "./PluginsSettingsTab";

// Official plugins, each registering its surface on import.
// import "./time-tracker"; // added in Task 8

installPluginNavGate();

registerSettingsTab({
  id: "plugins",
  label: "plugins.tab",
  content: <PluginsSettingsTab />,
  hideSave: true,
});
```

In `packages/frontend/src/registrations.tsx`, add at the top of the imports:

```tsx
import "@/plugins";
```

- [ ] **Step 5: Run the test**

Run: `bun test packages/frontend/src/tests/plugins-bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/plugins packages/frontend/src/tests/plugins-bootstrap.test.ts packages/frontend/src/registrations.tsx
git commit -m "feat(plugins): frontend plugin framework (store, guard, nav gate, settings tab)"
```

---

### Task 8: Time-tracker frontend port (page, api, i18n, registration)

**Files:**
- Create: `packages/frontend/src/plugins/time-tracker/api.ts` (copy from cloud, one addition)
- Create: `packages/frontend/src/plugins/time-tracker/i18n.ts` (copy from cloud, plus 2 new keys x 5 languages)
- Create: `packages/frontend/src/plugins/time-tracker/TimeTrackingPage.tsx` (copy from cloud, 3 edits)
- Create: `packages/frontend/src/plugins/time-tracker/index.tsx` (copy verbatim)
- Modify: `packages/frontend/src/plugins/index.tsx` (uncomment the time-tracker import)
- Modify: `packages/frontend/src/tests/plugins-bootstrap.test.ts` (extend)

**Interfaces:**
- Consumes: `pluginFetch` from `../api` (Task 7), `PluginGuard` (Task 7), `registerPlugin` (Task 7), OSS `registerRoute` / `registerNavItem` / `registerTranslations`, OSS auth store `useAuthStore` (`@/stores/auth.store`, exposes `user: { id, is_admin, role?, permissions? } | null`).
- Produces: nav item `/time-tracking` (section `nav.extensions`, pluginId `time-tracker`), protected route, `time_tracker.*` i18n in all 5 languages, `ttApi` typed client.

- [ ] **Step 1: Copy the four files from the cloud overlay**

```bash
mkdir -p inkvoice/packages/frontend/src/plugins/time-tracker
cp inkvoice-cloud/packages/frontend/src/plugins/time-tracker/api.ts   inkvoice/packages/frontend/src/plugins/time-tracker/api.ts
cp inkvoice-cloud/packages/frontend/src/plugins/time-tracker/i18n.ts  inkvoice/packages/frontend/src/plugins/time-tracker/i18n.ts
cp inkvoice-cloud/packages/frontend/src/plugins/time-tracker/TimeTrackingPage.tsx inkvoice/packages/frontend/src/plugins/time-tracker/TimeTrackingPage.tsx
cp inkvoice-cloud/packages/frontend/src/plugins/time-tracker/index.tsx inkvoice/packages/frontend/src/plugins/time-tracker/index.tsx
```

The cloud i18n file already carries all 5 languages (en, tr, de, es, fr): port it as-is.

- [ ] **Step 2: Add the user-filter i18n keys to all 5 languages**

Inside each `time_tracker: { ... }` block in the copied `i18n.ts`, add after `all_projects`:

```ts
    user: "User",
    all_users: "All users",
```

Language-specific values:

| lang | `user` | `all_users` |
|---|---|---|
| en | `"User"` | `"All users"` |
| tr | `"Kullanıcı"` | `"Tüm kullanıcılar"` |
| de | `"Benutzer"` | `"Alle Benutzer"` |
| es | `"Usuario"` | `"Todos los usuarios"` |
| fr | `"Utilisateur"` | `"Tous les utilisateurs"` |

- [ ] **Step 3: Extend the API client with the admin user filter**

In `packages/frontend/src/plugins/time-tracker/api.ts`, extend `EntryFilters`:

```ts
export interface EntryFilters {
  project_id?: string;
  billed?: boolean;
  from?: string;
  to?: string;
  /** Admin-only server-side filter; ignored for non-admin callers. */
  user_id?: string;
}
```

and pass it through in `listEntries`'s `qs({...})`:

```ts
  listEntries: (filters: EntryFilters = {}) =>
    pluginFetch<{ data: TtTimeEntry[] }>(
      `${BASE}/entries${qs({
        project_id: filters.project_id,
        billed: filters.billed === undefined ? undefined : String(filters.billed),
        from: filters.from,
        to: filters.to,
        user_id: filters.user_id,
      })}`,
    ).then((r) => r.data),
```

- [ ] **Step 4: Apply the page deltas**

In `packages/frontend/src/plugins/time-tracker/TimeTrackingPage.tsx`:

1. Add the auth import near the other imports:

```tsx
import { useAuthStore } from "@/stores/auth.store";
```

2. Inside the `TimeTrackingPage` component (top, next to the other hooks), add:

```tsx
  const { user } = useAuthStore();
  const isAdmin = !!user?.is_admin;
```

3. Admin-only user filter on the entries card. Where the entries filter row renders (find the Card containing `{t("time_tracker.entries")}` and the project `Select` bound to the project filter state), add a user `Select` next to it, rendered only when `isAdmin`:

```tsx
                {isAdmin && (
                  <div className="min-w-[160px]">
                    <Label>{t("time_tracker.user")}</Label>
                    <Select value={userIdFilter} onValueChange={setUserIdFilter}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("time_tracker.all_users")}</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.display_name || u.username}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
```

with state and data next to the page's other state (match the existing pattern used for the projects list; the page already loads data via `ttApi` calls in effects):

```tsx
  const [userIdFilter, setUserIdFilter] = useState("all");
  const [users, setUsers] = useState<{ id: string; username: string; display_name: string | null }[]>([]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .listUsers()
      .then((res) => setUsers(((res.data as any) ?? []) as { id: string; username: string; display_name: string | null }[]))
      .catch(() => undefined);
  }, [isAdmin]);
```

(`api` is imported from `@/api/client`; `listUsers` exists at `packages/frontend/src/api/client.ts:561`. Non-admins never hit this route, matching the backend's admin-only `GET /users`.)

and where entries are fetched, pass the filter through (convert `"all"` to undefined):

```ts
    ttApi.listEntries({
      project_id: projectFilter === "all" ? undefined : projectFilter,
      user_id: isAdmin && userIdFilter !== "all" ? userIdFilter : undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
    })
```

Use the page's actual state variable names (read the file first; it already has `project filter`, `from`, `to` states and a `loadEntries()` style function). Adapt names, do not rename existing state.

4. Gate project mutations on admin. The Projects card (Card titled `{t("time_tracker.projects")}`) renders "Add project" (`{t("time_tracker.add_project")}`) and per-row edit/archive/delete buttons. Wrap the create button and the row action buttons in `{isAdmin && (...)}` so non-admins see a read-only project list. Keep the project Select in the timer card untouched (all users need it to start timers).

5. Billing card visibility. The "Invoice unbilled time" card renders for users who can create invoices. Compute:

```tsx
  const canBill =
    !!user &&
    (user.is_admin ||
      user.role === "Owner" ||
      user.role === "Admin" ||
      (user.permissions ?? []).some((p) => p.resource === "invoices" && p.action === "create"));
```

Wrap the billing Card in `{canBill && ( ... )}`. The backend remains the enforcement point; a role-permitted user without the legacy permission array still gets the card, and the backend 403s if the role lacks the grant.

- [ ] **Step 5: Register the plugin in the OSS barrel**

In `packages/frontend/src/plugins/index.tsx`, replace the placeholder comment with:

```tsx
import "./time-tracker";
```

- [ ] **Step 6: Extend the bootstrap smoke test**

In `packages/frontend/src/tests/plugins-bootstrap.test.ts`, extend the first describe:

```ts
  test("registers the time-tracker route and nav item", () => {
    expect(protectedPaths).toContain("/time-tracking");
    expect(getNavItems().some((n) => n.to === "/time-tracking" && n.pluginId === "time-tracker")).toBe(true);
  });

  test("registers the time-tracker plugin metadata", () => {
    expect(getPlugins().some((p) => p.id === "time-tracker")).toBe(true);
  });
```

(`getPlugins` is imported from `@/plugins/registry`.)

- [ ] **Step 7: Run the tests and typecheck**

Run: `bun test packages/frontend/src/tests/plugins-bootstrap.test.ts && bun run typecheck`
Expected: PASS. If `@/` alias resolution fails under bun test, mirror the import style that `cloud-bootstrap.test.ts` uses (it resolves `@/` imports under bun test, so it should work; do not introduce new test tooling).

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/plugins packages/frontend/src/tests/plugins-bootstrap.test.ts
git commit -m "feat(plugins): time-tracker frontend with user scoping and admin filters"
```

---

### Task 9: Export/wipe coverage, feature docs, final check

**Files:**
- Modify: `packages/backend/src/routes/export.ts` (backup payload + wipe order)
- Create: `docs/features/plugins.md`
- Modify: `docs/features/index.md` (Tools section)

**Interfaces:**
- Consumes: nothing new.
- Produces: `tt_projects` and `tt_time_entries` included in JSON backup and wipe; the plugin-authoring doc.

- [ ] **Step 1: Add tt_ tables to the JSON backup**

In `exportRoutes.get("/backup")` (line ~14), after the `userPermissions` query add:

```ts
  const ttProjects = db.query("SELECT * FROM tt_projects").all();
  const ttTimeEntries = db.query("SELECT * FROM tt_time_entries").all();
```

and inside the `data` object after `user_permissions: userPermissions,`:

```ts
      tt_projects: ttProjects,
      tt_time_entries: ttTimeEntries,
```

Wrap the two queries in try/catch so backups of databases created before the plugin existed still work:

```ts
  const ttProjects = (() => {
    try {
      return db.query("SELECT * FROM tt_projects").all();
    } catch {
      return [];
    }
  })();
```

Apply the same pattern to `ttTimeEntries`. (This matches how a pre-plugin database lacks the tables.)

- [ ] **Step 2: Add tt_ tables to the wipe order**

In `exportRoutes.post("/wipe")`, add `"tt_time_entries"` and `"tt_projects"` as the first two entries of `wipeOrder` (children first; `tt_time_entries` references both `tt_projects` and `invoices`, and the loop tolerates missing tables).

- [ ] **Step 3: Write the feature doc**

Create `docs/features/plugins.md`:

```markdown
# Plugins

Inkvoice ships optional features as **plugins**: statically compiled-in,
official modules an admin can enable or disable under **Settings → Plugins**.
Time Tracking is the first official plugin.

## Managing plugins

- Open **Settings → Plugins** (admin only). Each plugin lists its name,
  description, and an Enable/Disable toggle.
- Disabling a plugin hides its sidebar entry and its pages, and its API
  answers 404. Its data is kept; re-enabling restores everything.
- Plugins are on or off per install. Nothing is downloaded at runtime.

## Time Tracking

Track time against projects and turn unbilled hours into draft invoices.

- **Projects** group time by client work. A project can be linked to a
  customer with a default hourly rate. Project management is admin-only.
- **Timer**: start/stop a personal timer from the Time Tracking page. One
  running timer per user.
- **Entries**: manual or timer-captured time with duration, rate, and
  billable flag. Non-admin users see and edit only their own entries;
  admins see and manage all entries.
- **Summary**: per-project totals (total, billable, unbilled time and value).
- **Invoice from unbilled time**: pick a customer and date range to create a
  draft invoice from unbilled billable time (one line per project and rate).
  Requires invoice creation permission. Entries are marked billed and linked
  to the invoice.

## API

Plugin endpoints live under `/api/v1/plugins/<plugin-id>/...` and require
authentication (session JWT or API token). Notes for integrators:

- `GET /api/v1/plugins` lists the catalog with per-install enablement.
- `PUT /api/v1/plugins/:id` toggles a plugin (admin only).
- Scoped API tokens (tokens with an explicit scope list) are limited to the
  invoicing resources and cannot access plugin paths. Unscoped API tokens act
  as their owner and can access plugin endpoints.
```

Add to `docs/features/index.md` under the `## Tools` section, at the end of the list:

```markdown
- **[Plugins](/features/plugins)**: Optional extensions like Time Tracking, enabled per install from Settings
```

- [ ] **Step 4: Full verification**

Run: `cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice && bun run check`
Expected: lint + typecheck + all tests green.

Run the app once for a manual smoke: `bun run dev`, log in, verify the Extensions section shows Time Tracking, the page loads, and Settings shows the Plugins tab.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/export.ts docs/features/plugins.md docs/features/index.md
git commit -m "feat(plugins): backup coverage and plugin docs"
```

- [ ] **Step 6: Push OSS**

Phase B needs `origin/main` updated. Run:

```bash
git push origin main
```

If you prefer to review the branch first, push to a feature branch and merge before continuing to Task 10.

---

## Phase B: Cloud overlay rework (Tasks 10-13)

All work happens in `/Users/baris/projects/inhouse/inkvoice-mono/inkvoice-cloud/`. Prerequisite: OSS Tasks 1-9 are merged to `pigontech/inkvoice` `main`.

### Task 10: Sync the OSS submodule

- [ ] **Step 1: Verify submodule mode**

```bash
cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice-cloud && bun run dev:link:status
```

Expected: `submodule (pinned)`. If it prints `linked`, run `bun run dev:unlink` first (the symlink and relinked bun.lock must never be committed, and `sync` aborts in linked mode by design).

- [ ] **Step 2: Dry-run then sync**

```bash
bun run sync:dry
bun run sync
```

Expected: `.sync-state.json` and the submodule pin move to the OSS commit containing this feature. If sync fails, resolve in submodule mode only; never force it in linked mode.

- [ ] **Step 3: Sanity typecheck before touching anything**

Run: `bun run typecheck`
Expected: passes with the submodule bumped but overlay untouched (the OSS additions are additive; the cloud framework still works side by side at this point).

---

### Task 11: Backend overlay rework

**Files:**
- Delete: `packages/backend/src/cloud/plugins/registry.ts`, `gate.ts`, `routes.ts`, `plugin-settings.service.ts`, `time-tracker/` (whole folder)
- Modify: `packages/backend/src/cloud/plugins/index.ts`, `packages/backend/src/cloud/plugins/france/index.ts`, `packages/backend/src/cloud/plugins/peppol/index.ts`
- Modify: `packages/backend/src/cloud/init.ts` (install feature gate, drop plugin mounting)
- Modify: `packages/backend/src/cloud/database/tenant-migrations.ts` (use the OSS runner)
- Modify: `packages/backend/src/tests/time-tracker.test.ts` (re-point + new signatures)

**Interfaces:**
- Consumes: OSS `registerBackendPlugin`, `getBackendPlugins`, `pluginGate`, `pluginsAdminRoutes`, `setPluginFeatureGate`, `runPluginMigrations` from `@oss/backend/plugins/*`; `requireFeature` from `./middleware/plan-limits`.
- Produces: cloud registers `france` and `peppol` into the OSS registry; the feature policy hook is installed in `initCloud()`.

- [ ] **Step 1: Install the feature gate and drop duplicate framework code**

In `packages/backend/src/cloud/init.ts`:

1. Delete the imports from `./plugins/registry`, `./plugins/gate`, `./plugins/routes` (those files are removed in this task) and add:

```ts
import { setPluginFeatureGate } from "@oss/backend/plugins/feature-gate";
```

(The feature hook lives in OSS `@oss/backend/plugins/feature-gate` as `setPluginFeatureGate`; the OSS registry exports `registerBackendPlugin`, `getBackendPlugins`, `getBackendPlugin` from `@oss/backend/plugins/registry`.)

2. In `initCloud()`, replace the "6b. Cloud plugins" block (manual `app.route`/`app.use` loop) with the policy injection only:

```ts
  // 6b. Plugins mount inside OSS createApp() from the shared registry. The
  // overlay contributes only its premium plugins (registered below via the
  // cloud/plugins barrel) and the plan-feature policy.
  setPluginFeatureGate((feature) => requireFeature(feature));
```

`requireFeature` is already imported from `./middleware/plan-limits`. Keep the `import "./plugins";` side-effect import at the top (the cloud barrel now registers france/peppol into the OSS registry).

3. Delete the now-duplicate files:
   - `packages/backend/src/cloud/plugins/registry.ts`
   - `packages/backend/src/cloud/plugins/gate.ts`
   - `packages/backend/src/cloud/plugins/routes.ts`
   - `packages/backend/src/cloud/plugins/plugin-settings.service.ts`
   - `packages/backend/src/cloud/plugins/time-tracker/` (entire folder)

4. In `packages/backend/src/cloud/plugins/france/index.ts` and `peppol/index.ts`, change the import:

```ts
import { registerBackendPlugin } from "@oss/backend/plugins/registry";
```

(and the `PluginMigration` type import in `migrations.ts` files, same module).

5. Update `packages/backend/src/cloud/plugins/index.ts` barrel to import only `./peppol` and `./france` and refresh its comment to say plugins register into the OSS registry (`@oss/backend/plugins/registry`) and mount through OSS `createApp`.

6. In `packages/backend/src/cloud/database/tenant-migrations.ts`, delete the local `runPluginMigrations()` (lines ~328-366) and re-export the OSS one instead:

```ts
import { runPluginMigrations } from "@oss/backend/plugins/runner";
export { runPluginMigrations };
```

`migrateAllTenants()` keeps calling it per tenant DB inside `runWithTenantDbAsync`, unchanged. `tenant.service.ts` keeps importing it from `../database/tenant-migrations`, so the re-export keeps that import working. Remove the imports the deleted function used that are now unused (`getBackendPlugins` from the deleted cloud registry; keep `getDb`/`logger` only if other code in the file still uses them).

- [ ] **Step 2: Re-point and update the cloud time-tracker test**

In `packages/backend/src/tests/time-tracker.test.ts`:

1. Change the service import to the OSS module:

```ts
import * as tt from "@oss/backend/plugins/time-tracker/service";
```

2. Update call sites to the new signatures (every entry-level function now takes an `Actor` first): `listEntries({ userId, isAdmin: true }, filters)`, `getSummary({ userId, isAdmin: true }, filters)`, `updateEntry({ userId, isAdmin: true }, id, input)`, `deleteEntry({ userId, isAdmin: true }, id)`. `user_id` in that suite is `"test-user"` style strings; pass them as `userId`.

3. Add a catalog-merge test:

```ts
test("official plugins register into the shared OSS registry", () => {
  const ids = getBackendPlugins().map((p) => p.id);
  expect(ids).toContain("time-tracker");
  expect(ids).toContain("france");
  expect(ids).toContain("peppol");
});
```

with `import { getBackendPlugins } from "@oss/backend/plugins/registry";`. (The test file already imports `../cloud/plugins`, which side-effect-imports the cloud barrel registering france + peppol; time-tracker now registers via OSS `app.ts`'s barrel import, which the test reaches through `createApp` or by importing `@oss/backend/plugins` directly.)

- [ ] **Step 3: Verify**

```bash
cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice-cloud && bun run typecheck && bun run test
```

Expected: green. The `time-tracker migrations` test asserting `plugin_schema_migrations` rows for `time-tracker` v1 must still pass unchanged (schema continuity).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(plugins): consume the OSS plugin framework"
```

---

### Task 12: Frontend overlay rework

**Files:**
- Delete: `packages/frontend/src/plugins/{api.ts,registry.ts,use-plugins.store.ts,PluginGuard.tsx,install-nav-gate.ts,PluginsSettingsTab.tsx,i18n.ts,index.tsx}` and `packages/frontend/src/plugins/time-tracker/` (whole folder)
- Modify: `packages/frontend/src/cloud-registrations.ts`
- Keep: `packages/frontend/src/plugins/france/` (registers into the OSS framework)

- [ ] **Step 1: Rewire the bootstrap**

In `packages/frontend/src/cloud-registrations.ts`, replace:

```ts
// Plugin framework + official plugins (nav, routes, i18n, enable/disable UI).
import "./plugins";
```

with:

```tsx
// OSS plugin framework (nav gate, Plugins tab) + the OSS time tracker come
// from the vendored OSS barrel; cloud adds only its own plugin surfaces.
import "@/plugins";
import "./plugins/france";
```

(`@/` resolves into the OSS sources for files the overlay does not override, which is exactly how `@/pages/settings-tab-registry` already resolves here.)

- [ ] **Step 2: Delete the duplicated framework and the cloud time-tracker**

```bash
cd inkvoice-cloud/packages/frontend/src/plugins
rm api.ts registry.ts use-plugins.store.ts PluginGuard.tsx install-nav-gate.ts PluginsSettingsTab.tsx i18n.ts index.tsx
rm -rf time-tracker
```

`france/index.tsx` only imports `@/pages/settings-tab-registry`, `./i18n`, and `./FranceSettings`, so it survives the deletion untouched.

- [ ] **Step 3: Verify the smoke test still passes**

`packages/frontend/src/tests/cloud-bootstrap.test.ts` imports `@/cloud-registrations` and asserts the `plugins` settings tab and the `/time-tracking` nav item. Both now come from the OSS barrel. Run:

```bash
bun run test
```

Expected: green, including `cloud-bootstrap.test.ts` asserting `/time-tracking` nav registration.

- [ ] **Step 4: Refresh the plugin authoring doc**

Rewrite `docs/plugins.md` so it describes authoring plugins against the OSS framework: point backend authors at `vendor/inkvoice-oss/docs/features/plugins.md` plus the OSS `packages/backend/src/plugins/` sources, keep the cloud-specific bits (register via the cloud barrel in `cloud/plugins/index.ts`, declare `feature: "..."` for plan gating, install the feature hook in `initCloud`), and delete references to the deleted cloud framework files. Keep the checklist but replace the cloud-specific bullets (registry/barrel paths) with the OSS paths.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(plugins): consume the OSS plugin framework on the frontend"
```

---

### Task 13: Cloud final verification

- [ ] **Step 1: Full typecheck + tests**

```bash
cd /Users/baris/projects/inhouse/inkvoice-mono/inkvoice-cloud && bun run typecheck && bun run test
```

Expected: green. If cloud typecheck reports unresolved `@oss/backend/plugins/*` imports, verify `tsconfig.json` paths still resolve and that the submodule pin includes the OSS feature commit (`bun run dev:link:status` shows the bumped SHA).

- [ ] **Step 2: Smoke the composed app**

```bash
bun run dev
```

Log in on a tenant: Time Tracking page works from the OSS-built surface, Settings shows the Plugins tab with Time Tracker + France (feature-gated), and enabling/disabling persists per tenant.

- [ ] **Step 3: Commit any stragglers**

```bash
git status   # must be clean
```

Phase B ends here. The optional site note ("Time tracking is now free in OSS") is a separate task in `inkvoice-site/` and is out of scope for this plan.

---

## Completion checklist

- [ ] All 13 tasks checked off, repos committed individually (OSS repo and cloud repo separately, never at the workspace root).
- [ ] OSS: `bun run check` green; cloud: `bun run typecheck && bun run test` green.
- [ ] Cloud tenant with existing time data: entries, projects, billed flags, and `plugin_schema_migrations` rows intact after upgrade (schema continuity).
- [ ] A tenant that had disabled time-tracker still sees it disabled.
- [ ] `docs/features/plugins.md` exists in OSS; cloud `docs/plugins.md` no longer references deleted files.
