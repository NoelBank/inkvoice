# Plugin Catalog Backend (spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the OSS backend a `GET /api/v1/plugins/catalog` endpoint that merges the locally compiled-in plugin registry with the public catalog published by `pigontech/inkvoice-plugins`, so the frontend can show versions, update state, and plugins this build cannot run.

**Architecture:** A catalog service fetches the remote JSON server-side on a 6h TTL, caches it in the existing settings KV, and falls back to a committed snapshot so the feature works air-gapped. A pure merge function combines that catalog with the registry. Three routes sit under a reserved `catalog` id segment. No new dependencies.

**Tech Stack:** Bun, Hono v4, `bun:sqlite` via the existing settings KV, Zod for request bodies, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-31-plugin-catalog-app-design.md` (Part 1 only; Part 2, the frontend, is a separate plan).

**Depends on:** spec A, already implemented in `inkvoice-mono/inkvoice-plugins`. That repo is complete but **not yet published**, so the URLs this plan targets do not resolve yet. That is fine and is designed for: every task here is testable against the committed snapshot and stubbed fetches. Nothing in this plan requires network access.

## Global Constraints

- **Semver is strict `MAJOR.MINOR.PATCH`.** No prerelease, no build metadata. Regex: `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`.
- **The catalog `schema` field must equal the literal number `1`.** A payload with any other value is rejected in favour of the snapshot.
- **Reserved plugin ids: `["catalog"]`.** `registerBackendPlugin` throws on them.
- **Default catalog URL:** `https://inkvoice.app/plugins/catalog.v1.json`. **Default votes URL:** `https://inkvoice.app/api/plugin-votes`.
- **`plugin_catalog_url` set to the empty string disables ALL catalog egress**, votes included. No socket is opened. This is the self-hoster's off switch and must be honoured on every path.
- **Fetch timeout is 5 seconds, single attempt, no retry loop.**
- **TTL is 6 hours.**
- **A failed fetch is never an error state.** It degrades to cache, then to snapshot, and reports why. The endpoint returns 200 with provenance, never 5xx, when the remote is unreachable.
- **API response shape:** `{ success: true, data: ... }` or `{ success: false, error: "..." }`, matching the rest of the codebase.
- **No em dashes or en dashes** in prose or code comments. Use commas, periods or parentheses.
- **Commit messages: title line only**, no body, no `Co-Authored-By` trailer.

## Three reconciliations, applied in this plan

The spec was written before spec A was implemented. Reality diverged in three places. Implement the corrected versions.

**1. The field is `requires_feature`, not `requires_plan`.** The spec's merged payload and its `blockedReason` enum both say `requires_plan`. During spec A's final review the owner renamed it, because the value holds a `BackendPlugin.feature` id (`peppol`, `france`), not a plan name, and published field names cannot change without a v2. Verify against the shipped artifact before you start:

```bash
cd ../inkvoice-plugins && bun run build && python3 -c "
import json; print(sorted(json.load(open('dist/catalog.v1.json'))['plugins'][0].keys()))"
```

Expected output includes `requires_feature` and no `requires_plan`. Everything in this plan follows that: the merged entry's `blockedReason` value is `"requires_feature"`, and the entitlement seam takes a feature id.

**2. The backend has no app version.** `APP_VERSION` exists only at `packages/frontend/src/lib/version.ts`, which inlines the frontend `package.json` version at build time. `updateRequiresApp` needs the version server-side, so Task 1 adds a backend equivalent reading `packages/backend/package.json`. The release process already keeps all three `package.json` versions in lockstep, so this stays correct without new discipline.

**3. `blockedReason` needs a fifth value the spec omits.** The spec lists `null | "cloud_only" | "requires_plan" | "planned"`. That does not cover a catalog entry with `availability: "oss"` or `"both"` that this build does not ship, which happens whenever the catalog is newer than the installed app. The honest reason is that the app needs upgrading, so the enum gains `"requires_app_upgrade"`. Without it that case would fall through to `null` and render an Enable switch for a plugin that does not exist in this binary, which is exactly the dishonest UI the spec exists to prevent.

Final enum: `null | "planned" | "cloud_only" | "requires_feature" | "requires_app_upgrade"`.

---

### Task 1: Backend app version, strict semver, and the registry version field

**Files:**
- Create: `packages/backend/src/utils/version.ts`
- Create: `packages/backend/src/plugins/semver.ts`
- Modify: `packages/backend/src/plugins/registry.ts`
- Modify: `packages/backend/src/plugins/time-tracker/index.ts`
- Create: `packages/backend/src/tests/plugin-semver.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `APP_VERSION` from `utils/version.ts`; `compare(a, b): number`, `gt(a, b): boolean`, `gte(a, b): boolean` from `plugins/semver.ts`; `RESERVED_PLUGIN_IDS` and a required `version: string` on `BackendPlugin`.

This task contains the only compile-breaking change in the plan. Adding a required field to `BackendPlugin` breaks every downstream registration, which today means the two cloud overlay plugins. Spec D covers those; TypeScript catches them before anything ships.

- [ ] **Step 1: Write the failing semver test**

Create `packages/backend/src/tests/plugin-semver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { compare, gt, gte } from "../plugins/semver";

describe("plugin semver", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compare("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compare("1.2.0", "1.3.0")).toBeLessThan(0);
    expect(compare("1.0.2", "1.0.3")).toBeLessThan(0);
  });

  test("compares numerically, not lexically", () => {
    expect(compare("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compare("0.10.0", "0.2.0")).toBeGreaterThan(0);
  });

  test("treats equal versions as equal", () => {
    expect(compare("1.2.3", "1.2.3")).toBe(0);
  });

  test("gt is strict", () => {
    expect(gt("1.1.0", "1.0.0")).toBe(true);
    expect(gt("1.0.0", "1.0.0")).toBe(false);
    expect(gt("1.0.0", "1.1.0")).toBe(false);
  });

  test("gte allows equality", () => {
    expect(gte("1.0.0", "1.0.0")).toBe(true);
    expect(gte("1.1.0", "1.0.0")).toBe(true);
    expect(gte("0.9.0", "1.0.0")).toBe(false);
  });

  test("the app-version comparison the update badge depends on", () => {
    // APP_VERSION 0.2.0 against a plugin release needing 0.3.0.
    expect(gte("0.2.0", "0.3.0")).toBe(false);
    expect(gte("0.3.0", "0.3.0")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/backend/src/tests/plugin-semver.test.ts`
Expected: FAIL, cannot resolve `../plugins/semver`.

- [ ] **Step 3: Write `packages/backend/src/plugins/semver.ts`**

```ts
// Strict MAJOR.MINOR.PATCH comparison. The catalog schema forbids prerelease
// and build metadata, so this deliberately handles nothing else and takes no
// dependency. Inputs are assumed to have already matched the catalog's semver
// pattern; malformed input compares as 0.

export function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when a is strictly newer than b. */
export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

/** True when a is at least b. Used for "does this app satisfy min_app". */
export function gte(a: string, b: string): boolean {
  return compare(a, b) >= 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/backend/src/tests/plugin-semver.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write `packages/backend/src/utils/version.ts`**

```ts
// App version for the backend. The frontend has its own copy at
// lib/version.ts reading the frontend package.json; this reads the backend's.
// The release process bumps all three package.json versions together, so the
// two stay in lockstep without extra wiring.
//
// Used to decide whether this install satisfies a plugin release's min_app.
import { version } from "../../package.json";

export const APP_VERSION: string = version;
```

- [ ] **Step 6: Add the version field and reserved-id guard to the registry**

In `packages/backend/src/plugins/registry.ts`, add to the `BackendPlugin` interface, directly after the `id` field:

```ts
  /** Strict semver of this plugin's own implementation, independent of the app
   *  version. Compared against the catalog's latest to drive the update badge.
   *  Bump it whenever the plugin's behaviour changes. */
  version: string;
```

Above the `PLUGINS` array, add:

```ts
/** Ids the app mounts its own routes under, so a plugin may never claim them.
 *  A plugin with id "catalog" would shadow /api/v1/plugins/catalog. Mirrored as
 *  a validation rule in the pigontech/inkvoice-plugins catalog repo. */
export const RESERVED_PLUGIN_IDS = ["catalog"] as const;
```

And at the top of `registerBackendPlugin`, before the idempotent-replace logic:

```ts
  if ((RESERVED_PLUGIN_IDS as readonly string[]).includes(plugin.id)) {
    throw new Error(`Plugin id "${plugin.id}" is reserved`);
  }
```

- [ ] **Step 7: Give Time Tracker a version**

In `packages/backend/src/plugins/time-tracker/index.ts`, add `version: "1.0.0",` to the `registerBackendPlugin({...})` call, directly after `id: "time-tracker",`.

This value must match the `time-tracker` entry in the catalog repo. Confirm with:

```bash
grep -A2 '^versions:' ../inkvoice-plugins/plugins/time-tracker/plugin.yaml
```

Expected: `- version: "1.0.0"`. If it differs, the catalog is the source of truth for what has shipped; use its value and note the discrepancy in your report.

- [ ] **Step 8: Extend the framework test for the reserved id**

Append to `packages/backend/src/tests/plugin-framework.test.ts`, inside its existing top-level `describe`:

```ts
  test("rejects a reserved plugin id", () => {
    expect(() =>
      registerBackendPlugin({
        id: "catalog",
        version: "1.0.0",
        routes: new Hono(),
        migrations: [],
      }),
    ).toThrow(/reserved/i);
  });
```

That file's existing `dummyPlugin()` helper builds registrations without a `version`, which now fails to typecheck. Add `version: "1.0.0",` to it.

- [ ] **Step 9: Run the backend suite and typecheck**

Run: `bun test packages/backend && bun run typecheck`
Expected: all backend tests pass. Typecheck fails ONLY inside `inkvoice-cloud` if that is composed into this graph; within this repo it must be clean. If any OSS file fails to typecheck, fix it, that is a real break from the new required field.

- [ ] **Step 10: Commit**

```bash
git add packages/backend/src/utils/version.ts packages/backend/src/plugins/semver.ts packages/backend/src/plugins/registry.ts packages/backend/src/plugins/time-tracker/index.ts packages/backend/src/tests/plugin-semver.test.ts packages/backend/src/tests/plugin-framework.test.ts
git commit -m "feat: plugin versions, strict semver, reserved plugin ids"
```

---

### Task 2: Entitlement seam and the bundled catalog snapshot

**Files:**
- Create: `packages/backend/src/plugins/entitlement.ts`
- Create: `packages/backend/src/plugins/catalog-snapshot.json`
- Create: `packages/backend/src/tests/plugin-entitlement.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PluginEntitlementCheck`, `setPluginEntitlementCheck(fn)`, `getPluginEntitlementCheck()` from `plugins/entitlement.ts`; the committed snapshot file that Task 3 falls back to.

- [ ] **Step 1: Write the failing entitlement test**

Create `packages/backend/src/tests/plugin-entitlement.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  getPluginEntitlementCheck,
  setPluginEntitlementCheck,
} from "../plugins/entitlement";

afterEach(() => setPluginEntitlementCheck(null));

describe("plugin entitlement seam", () => {
  test("defaults to none installed, so OSS treats everything as entitled", () => {
    expect(getPluginEntitlementCheck()).toBeNull();
  });

  test("an installed resolver is returned and consulted", () => {
    setPluginEntitlementCheck((feature) => feature === "peppol");
    const check = getPluginEntitlementCheck();
    expect(check).not.toBeNull();
    expect(check?.("peppol")).toBe(true);
    expect(check?.("france")).toBe(false);
  });

  test("passing null uninstalls it", () => {
    setPluginEntitlementCheck(() => true);
    setPluginEntitlementCheck(null);
    expect(getPluginEntitlementCheck()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/backend/src/tests/plugin-entitlement.test.ts`
Expected: FAIL, cannot resolve `../plugins/entitlement`.

- [ ] **Step 3: Write `packages/backend/src/plugins/entitlement.ts`**

```ts
// Injectable, read-only plan-feature policy, the counterpart to feature-gate.ts.
// feature-gate.ts decides whether a REQUEST is allowed; this decides whether the
// catalog should show an enable switch at all. OSS ships no plans, so the
// default is null, meaning everything is entitled and OSS behaviour is
// unchanged. An overlay installs its resolver at boot alongside
// setPluginFeatureGate.
//
// The two must agree. A plugin whose gate denies at request time while this
// says yes would render an enable switch that produces a 402.

/** Receives a plugin's `feature` id (for example "peppol"), not a plan name. */
export type PluginEntitlementCheck = (feature: string) => boolean;

let entitlementCheck: PluginEntitlementCheck | null = null;

export function setPluginEntitlementCheck(fn: PluginEntitlementCheck | null): void {
  entitlementCheck = fn;
}

export function getPluginEntitlementCheck(): PluginEntitlementCheck | null {
  return entitlementCheck;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/backend/src/tests/plugin-entitlement.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Generate the bundled snapshot from the real catalog**

The snapshot is what makes the Plugins tab work air-gapped and on first boot before any fetch. Generate it from the spec A repo rather than hand-writing it:

```bash
cd ../inkvoice-plugins && bun run build && cp dist/catalog.v1.json ../inkvoice/packages/backend/src/plugins/catalog-snapshot.json
cd ../inkvoice
```

Then open the copied file and **delete the `generated_at` line**. It changes on every build, so leaving it makes the committed snapshot churn in every release diff for no information. Task 3 types it as optional and its validation checks only `schema` and `plugins`, so removing it is safe.

Verify the result:

```bash
python3 -c "
import json; d=json.load(open('packages/backend/src/plugins/catalog-snapshot.json'))
print('schema:', d['schema']); print('plugins:', [p['id'] for p in d['plugins']])
print('fields:', sorted(d['plugins'][0].keys()))"
```

Expected: `schema: 1`, four plugins (`accounts-payable`, `france`, `peppol`, `time-tracker`), and a field list containing `requires_feature`.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/plugins/entitlement.ts packages/backend/src/plugins/catalog-snapshot.json packages/backend/src/tests/plugin-entitlement.test.ts
git commit -m "feat: plugin entitlement seam and bundled catalog snapshot"
```

---

### Task 3: The catalog service

**Files:**
- Create: `packages/backend/src/plugins/catalog.service.ts`
- Create: `packages/backend/src/tests/plugin-catalog-service.test.ts`

**Interfaces:**
- Consumes: the snapshot from Task 2.
- Produces: from `plugins/catalog.service.ts`: types `CatalogVersion`, `CatalogScreenshot`, `CatalogPlugin`, `Catalog`, `CatalogResult`; constants `DEFAULT_CATALOG_URL`, `DEFAULT_VOTES_URL`, `CATALOG_TTL_MS`; functions `catalogEgressEnabled(): boolean`, `getCatalog(opts?: { force?: boolean }): Promise<CatalogResult>`, `getVotes(): Promise<Record<string, number>>`, `postVote(id: string): Promise<number | null>`.

This is the task with the most behaviour. The four settings keys, the TTL, the fallback chain and the off switch all live here.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/tests/plugin-catalog-service.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { getCatalog, getVotes, postVote } from "../plugins/catalog.service";
import { getSetting, updateSettings } from "../services/settings.service";

const TEST_DB = "./data/test-plugin-catalog-service.db";

// A minimal but shape-valid catalog payload, distinguishable from the snapshot
// by its single made-up plugin id.
const REMOTE = {
  schema: 1,
  generated_at: "2026-09-01T00:00:00.000Z",
  plugins: [
    {
      id: "remote-only",
      name: "Remote Only",
      tagline: "Present in the remote catalog only.",
      description: "Body.",
      category: "productivity",
      status: "available",
      availability: "both",
      requires_feature: null,
      icon: "Clock",
      docs: "https://example.com/docs",
      source: null,
      screenshots: [],
      latest: { version: "2.0.0", min_app: "0.2.0", released: "2026-09-01" },
      versions: [{ version: "2.0.0", min_app: "0.2.0", released: "2026-09-01" }],
    },
  ],
};

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

/** Replace fetch for one test. `impl` receives the requested URL. */
function stubFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    return impl(url);
  }) as typeof fetch;
}

const ok = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeAll(() => {
  initDatabase(TEST_DB);
  runMigrations();
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

beforeEach(() => {
  fetchCalls = [];
  updateSettings({
    plugin_catalog_url: "",
    plugin_catalog_cache: "",
    plugin_catalog_synced_at: "",
    plugin_catalog_votes: "",
  });
  // Empty string means "off"; most tests want the default URL, so clear it by
  // writing the default back where needed.
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function enableEgress() {
  updateSettings({ plugin_catalog_url: "https://example.test/catalog.v1.json" });
}

describe("catalog service", () => {
  test("with egress off it never opens a socket and reports snapshot", async () => {
    stubFetch(() => {
      throw new Error("fetch must not be called");
    });
    const res = await getCatalog();
    expect(fetchCalls).toEqual([]);
    expect(res.source).toBe("snapshot");
    expect(res.catalog.schema).toBe(1);
    expect(res.catalog.plugins.some((p) => p.id === "time-tracker")).toBe(true);
  });

  test("a cold cache fetches remote and writes the cache and timestamp", async () => {
    enableEgress();
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog();
    expect(res.source).toBe("remote");
    expect(res.catalog.plugins[0]!.id).toBe("remote-only");
    expect(getSetting("plugin_catalog_cache")).toContain("remote-only");
    expect(getSetting("plugin_catalog_synced_at")).toBeTruthy();
    expect(fetchCalls).toHaveLength(1);
  });

  test("a fresh cache is used without fetching", async () => {
    enableEgress();
    stubFetch(() => ok(REMOTE));
    await getCatalog();
    fetchCalls = [];
    stubFetch(() => {
      throw new Error("must not refetch a fresh cache");
    });
    const res = await getCatalog();
    expect(res.source).toBe("cache");
    expect(fetchCalls).toEqual([]);
  });

  test("force bypasses a fresh cache", async () => {
    enableEgress();
    stubFetch(() => ok(REMOTE));
    await getCatalog();
    fetchCalls = [];
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog({ force: true });
    expect(res.source).toBe("remote");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a stale cache triggers a fetch", async () => {
    enableEgress();
    updateSettings({
      plugin_catalog_cache: JSON.stringify(REMOTE),
      plugin_catalog_synced_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog();
    expect(res.source).toBe("remote");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a failed fetch falls back to a stale cache and reports the error", async () => {
    enableEgress();
    updateSettings({
      plugin_catalog_cache: JSON.stringify(REMOTE),
      plugin_catalog_synced_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    stubFetch(() => Promise.reject(new Error("network down")));
    const res = await getCatalog();
    expect(res.source).toBe("cache");
    expect(res.error).toContain("network down");
    expect(res.catalog.plugins[0]!.id).toBe("remote-only");
  });

  test("a failed fetch with no cache falls back to the snapshot", async () => {
    enableEgress();
    stubFetch(() => Promise.reject(new Error("network down")));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toContain("network down");
    expect(res.catalog.plugins.some((p) => p.id === "time-tracker")).toBe(true);
  });

  test("a non-200 response is treated as a failure", async () => {
    enableEgress();
    stubFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toBeTruthy();
  });

  test("a payload with the wrong schema version is rejected", async () => {
    enableEgress();
    stubFetch(() => ok({ ...REMOTE, schema: 2 }));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toMatch(/schema/i);
    expect(getSetting("plugin_catalog_cache")).toBeFalsy();
  });

  test("a structurally invalid payload is rejected", async () => {
    enableEgress();
    stubFetch(() => ok({ schema: 1, plugins: "not an array" }));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toBeTruthy();
  });

  test("a corrupt cache does not poison the result", async () => {
    enableEgress();
    updateSettings({
      plugin_catalog_cache: "{ not json",
      plugin_catalog_synced_at: new Date().toISOString(),
    });
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog();
    expect(res.source).toBe("remote");
  });

  test("votes are fetched, cached, and empty when egress is off", async () => {
    enableEgress();
    stubFetch(() => ok({ "accounts-payable": 7 }));
    expect(await getVotes()).toEqual({ "accounts-payable": 7 });

    updateSettings({ plugin_catalog_url: "" });
    stubFetch(() => {
      throw new Error("must not fetch votes with egress off");
    });
    expect(await getVotes()).toEqual({});
  });

  test("postVote returns the new count and is a no-op when egress is off", async () => {
    enableEgress();
    stubFetch(() => ok({ count: 8, voted: true }));
    expect(await postVote("accounts-payable")).toBe(8);

    updateSettings({ plugin_catalog_url: "" });
    fetchCalls = [];
    stubFetch(() => {
      throw new Error("must not post a vote with egress off");
    });
    expect(await postVote("accounts-payable")).toBeNull();
    expect(fetchCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/backend/src/tests/plugin-catalog-service.test.ts`
Expected: FAIL, cannot resolve `../plugins/catalog.service`.

- [ ] **Step 3: Write `packages/backend/src/plugins/catalog.service.ts`**

```ts
// Fetches the public plugin catalog server-side, caches it in the settings KV
// on a TTL, and falls back to a snapshot committed to this repo. Server-side so
// that a self-hosted install makes one predictable outbound request from the
// server rather than one per browser, with no CORS and one place to switch it
// off.
//
// The tab must never be empty and never spin: a remote fetch only ever improves
// the data. Every failure path still returns a usable catalog plus a reason.

import { getSetting, updateSettings } from "../services/settings.service";
import { logger } from "../utils/logger";
import snapshot from "./catalog-snapshot.json";

export const DEFAULT_CATALOG_URL = "https://inkvoice.app/plugins/catalog.v1.json";
export const DEFAULT_VOTES_URL = "https://inkvoice.app/api/plugin-votes";
export const DEFAULT_VOTE_POST_URL = "https://inkvoice.app/api/plugin-vote";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

const KEY_URL = "plugin_catalog_url";
const KEY_CACHE = "plugin_catalog_cache";
const KEY_SYNCED_AT = "plugin_catalog_synced_at";
const KEY_VOTES = "plugin_catalog_votes";

export interface CatalogVersion {
  version: string;
  min_app: string;
  released: string;
  changelog?: string;
}

export interface CatalogScreenshot {
  url: string;
  alt: string;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  status: "available" | "planned";
  availability: "oss" | "cloud" | "both";
  /** The plugin's `feature` id, gating it on a Cloud plan. Null when ungated. */
  requires_feature: string | null;
  icon: string;
  docs: string;
  source: string | null;
  screenshots: CatalogScreenshot[];
  latest: CatalogVersion | null;
  versions: CatalogVersion[];
}

export interface Catalog {
  schema: number;
  generated_at?: string;
  plugins: CatalogPlugin[];
}

export interface CatalogResult {
  catalog: Catalog;
  source: "remote" | "cache" | "snapshot";
  /** ISO timestamp of the last successful remote fetch, null if never. */
  syncedAt: string | null;
  /** Why the remote was not used this time, null when it was. */
  error: string | null;
}

/** The configured source URL. Empty string means egress is switched off. */
function catalogUrl(): string {
  const raw = getSetting(KEY_URL);
  return raw === null ? DEFAULT_CATALOG_URL : raw;
}

export function catalogEgressEnabled(): boolean {
  return catalogUrl() !== "";
}

/** Shape check. Deliberately shallow: we validate the envelope and let unknown
 *  plugin fields through, because the contract promises additive v1 changes. */
function isCatalog(value: unknown): value is Catalog {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schema === 1 && Array.isArray(v.plugins);
}

function readCache(): { catalog: Catalog; syncedAt: string | null } | null {
  const raw = getSetting(KEY_CACHE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isCatalog(parsed)) return null;
    return { catalog: parsed, syncedAt: getSetting(KEY_SYNCED_AT) || null };
  } catch {
    return null;
  }
}

function isFresh(syncedAt: string | null): boolean {
  if (!syncedAt) return false;
  const at = Date.parse(syncedAt);
  if (Number.isNaN(at)) return false;
  return Date.now() - at < CATALOG_TTL_MS;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function snapshotResult(error: string | null, syncedAt: string | null): CatalogResult {
  return {
    catalog: snapshot as unknown as Catalog,
    source: "snapshot",
    syncedAt,
    error,
  };
}

/**
 * Resolution order: fresh cache, then remote, then stale cache, then the
 * bundled snapshot. With egress off, only the snapshot is ever consulted.
 */
export async function getCatalog(opts: { force?: boolean } = {}): Promise<CatalogResult> {
  const url = catalogUrl();
  if (url === "") return snapshotResult(null, null);

  const cached = readCache();
  if (!opts.force && cached && isFresh(cached.syncedAt)) {
    return { catalog: cached.catalog, source: "cache", syncedAt: cached.syncedAt, error: null };
  }

  try {
    const payload = await fetchJson(url);
    if (!isCatalog(payload)) {
      throw new Error("unexpected catalog schema or shape");
    }
    const syncedAt = new Date().toISOString();
    updateSettings({
      [KEY_CACHE]: JSON.stringify(payload),
      [KEY_SYNCED_AT]: syncedAt,
    });
    return { catalog: payload, source: "remote", syncedAt, error: null };
  } catch (err) {
    const message = (err as Error).message || "catalog fetch failed";
    logger.warn({ url, err: message }, "Plugin catalog fetch failed");
    if (cached) {
      return { catalog: cached.catalog, source: "cache", syncedAt: cached.syncedAt, error: message };
    }
    return snapshotResult(message, null);
  }
}

/** Demand-vote counts by plugin id. Empty when egress is off or unreachable.
 *  Deliberately reuses the catalog's synced_at as its freshness window rather
 *  than keeping a second timestamp: votes are a soft signal, and one clock is
 *  one fewer thing to keep consistent. */
export async function getVotes(): Promise<Record<string, number>> {
  if (!catalogEgressEnabled()) return {};

  const cachedRaw = getSetting(KEY_VOTES);
  const syncedAt = getSetting(KEY_SYNCED_AT);
  if (cachedRaw && isFresh(syncedAt)) {
    try {
      return JSON.parse(cachedRaw) as Record<string, number>;
    } catch {
      // fall through and refetch
    }
  }

  try {
    const payload = await fetchJson(DEFAULT_VOTES_URL);
    if (typeof payload !== "object" || payload === null) return {};
    const counts = payload as Record<string, number>;
    updateSettings({ [KEY_VOTES]: JSON.stringify(counts) });
    return counts;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Plugin vote fetch failed");
    if (cachedRaw) {
      try {
        return JSON.parse(cachedRaw) as Record<string, number>;
      } catch {
        return {};
      }
    }
    return {};
  }
}

/** Registers interest in a planned plugin. Returns the new count, or null when
 *  egress is off or the request failed. */
export async function postVote(id: string): Promise<number | null> {
  if (!catalogEgressEnabled()) return null;
  try {
    const res = await fetch(DEFAULT_VOTE_POST_URL, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { count?: number };
    return typeof data.count === "number" ? data.count : null;
  } catch (err) {
    logger.warn({ id, err: (err as Error).message }, "Plugin vote failed");
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/backend/src/tests/plugin-catalog-service.test.ts`
Expected: PASS, 13 tests.

The JSON import needs no extra configuration: `packages/backend/tsconfig.json` already sets `"resolveJsonModule": true`, and Bun imports JSON natively. Confirm with `bun run typecheck` before moving on. This will be the first JSON import in the backend, so if typecheck complains, report it rather than working around it.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/plugins/catalog.service.ts packages/backend/src/tests/plugin-catalog-service.test.ts
git commit -m "feat: plugin catalog service with cache, snapshot fallback and off switch"
```

---

### Task 4: The merge

**Files:**
- Create: `packages/backend/src/plugins/merge.ts`
- Create: `packages/backend/src/tests/plugin-merge.test.ts`

**Interfaces:**
- Consumes: `CatalogPlugin` from Task 3; `gt`, `gte` from Task 1.
- Produces: from `plugins/merge.ts`: types `BlockedReason`, `MergedPlugin`, `MergeInput`; function `mergePlugins(input: MergeInput): MergedPlugin[]`.

Pure and side-effect free. It takes the catalog, the local registry's facts, the app version, the votes and an entitlement predicate, and returns what the UI renders. Keeping it out of the route handler is what makes every branch testable without HTTP or a database.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/tests/plugin-merge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CatalogPlugin } from "../plugins/catalog.service";
import { mergePlugins } from "../plugins/merge";

function entry(over: Partial<CatalogPlugin> = {}): CatalogPlugin {
  return {
    id: "time-tracker",
    name: "Time Tracker",
    tagline: "Track billable hours.",
    description: "Body.",
    category: "productivity",
    status: "available",
    availability: "both",
    requires_feature: null,
    icon: "Clock",
    docs: "https://example.com/docs",
    source: null,
    screenshots: [],
    latest: { version: "1.0.0", min_app: "0.2.0", released: "2026-06-08" },
    versions: [{ version: "1.0.0", min_app: "0.2.0", released: "2026-06-08" }],
    ...over,
  };
}

const base = {
  appVersion: "0.2.0",
  votes: {},
  isEntitled: () => true,
};

const installed = (id: string, version: string, enabled: boolean) => ({
  id,
  version,
  enabled,
});

describe("mergePlugins", () => {
  test("an installed, enabled, current plugin has no blocker and no update", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry()],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(p!.installed).toBe(true);
    expect(p!.enabled).toBe(true);
    expect(p!.installedVersion).toBe("1.0.0");
    expect(p!.latestVersion).toBe("1.0.0");
    expect(p!.updateAvailable).toBe(false);
    expect(p!.blockedReason).toBeNull();
  });

  test("a newer catalog version sets updateAvailable", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ latest: { version: "1.1.0", min_app: "0.2.0", released: "2026-09-01" } })],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(p!.updateAvailable).toBe(true);
    expect(p!.latestVersion).toBe("1.1.0");
    expect(p!.updateRequiresApp).toBeNull();
  });

  test("updateRequiresApp is set only when the app is below the release's min_app", () => {
    const needs03 = entry({
      latest: { version: "1.1.0", min_app: "0.3.0", released: "2026-09-01" },
    });
    const [below] = mergePlugins({
      ...base,
      catalog: [needs03],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(below!.updateRequiresApp).toBe("0.3.0");

    const [above] = mergePlugins({
      ...base,
      appVersion: "0.3.0",
      catalog: [needs03],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(above!.updateRequiresApp).toBeNull();
  });

  test("needing a newer app does not block enabling what is already installed", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ latest: { version: "1.1.0", min_app: "0.3.0", released: "2026-09-01" } })],
      installed: [installed("time-tracker", "1.0.0", false)],
    });
    expect(p!.updateRequiresApp).toBe("0.3.0");
    expect(p!.blockedReason).toBeNull();
  });

  test("a cloud-only entry this build lacks is blocked as cloud_only", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ id: "peppol", availability: "cloud", requires_feature: "peppol" })],
      installed: [],
    });
    expect(p!.installed).toBe(false);
    expect(p!.blockedReason).toBe("cloud_only");
  });

  test("an installed plan-gated plugin is blocked only when the resolver denies", () => {
    const gated = entry({ id: "peppol", availability: "cloud", requires_feature: "peppol" });
    const [denied] = mergePlugins({
      ...base,
      isEntitled: () => false,
      catalog: [gated],
      installed: [installed("peppol", "1.0.0", false)],
    });
    expect(denied!.blockedReason).toBe("requires_feature");

    const [allowed] = mergePlugins({
      ...base,
      isEntitled: (f) => f === "peppol",
      catalog: [gated],
      installed: [installed("peppol", "1.0.0", false)],
    });
    expect(allowed!.blockedReason).toBeNull();
  });

  test("a planned entry is blocked as planned and carries its vote count", () => {
    const [p] = mergePlugins({
      ...base,
      votes: { "accounts-payable": 12 },
      catalog: [
        entry({ id: "accounts-payable", status: "planned", latest: null, versions: [] }),
      ],
      installed: [],
    });
    expect(p!.blockedReason).toBe("planned");
    expect(p!.votes).toBe(12);
    expect(p!.latestVersion).toBeNull();
    expect(p!.installed).toBe(false);
  });

  test("an oss entry this build does not ship asks for an app upgrade", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ id: "future-plugin", availability: "both" })],
      installed: [],
    });
    expect(p!.blockedReason).toBe("requires_app_upgrade");
  });

  test("a registry-only plugin absent from the catalog still appears", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [],
      installed: [installed("my-fork-plugin", "3.1.4", true)],
    });
    expect(p!.id).toBe("my-fork-plugin");
    expect(p!.installed).toBe(true);
    expect(p!.enabled).toBe(true);
    expect(p!.installedVersion).toBe("3.1.4");
    expect(p!.latestVersion).toBeNull();
    expect(p!.updateAvailable).toBe(false);
    expect(p!.blockedReason).toBeNull();
    expect(p!.name).toBe("my-fork-plugin");
  });

  test("results are sorted by id so the payload is stable", () => {
    const merged = mergePlugins({
      ...base,
      catalog: [entry({ id: "zeta" }), entry({ id: "alpha" })],
      installed: [installed("mid", "1.0.0", false)],
    });
    expect(merged.map((p) => p.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("votes default to zero when absent", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry()],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(p!.votes).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/backend/src/tests/plugin-merge.test.ts`
Expected: FAIL, cannot resolve `../plugins/merge`.

- [ ] **Step 3: Write `packages/backend/src/plugins/merge.ts`**

```ts
// Combines the public catalog with what this build actually ships. Pure: the
// registry, the database and the network are all resolved by the caller and
// passed in, so every branch below is testable without any of them.
//
// The union is deliberate. A plugin registered locally but missing from the
// catalog (a fork, or a plugin newer than the published catalog) still appears,
// built from registry data alone.

import type { CatalogPlugin } from "./catalog.service";
import { gt, gte } from "./semver";

/** Why there is no working enable switch. Null means the switch works. */
export type BlockedReason =
  | null
  | "planned"
  | "cloud_only"
  | "requires_feature"
  | "requires_app_upgrade";

export interface InstalledPlugin {
  id: string;
  version: string;
  enabled: boolean;
}

export interface MergeInput {
  catalog: CatalogPlugin[];
  installed: InstalledPlugin[];
  appVersion: string;
  votes: Record<string, number>;
  /** Receives a plugin's `feature` id. OSS passes a function returning true. */
  isEntitled: (feature: string) => boolean;
}

export interface MergedPlugin {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  status: "available" | "planned";
  availability: "oss" | "cloud" | "both";
  icon: string;
  docs: string | null;
  source: string | null;
  screenshots: { url: string; alt: string }[];
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** The min_app of the latest release, when this app is below it. */
  updateRequiresApp: string | null;
  enabled: boolean;
  blockedReason: BlockedReason;
  votes: number;
}

function blockedReasonFor(
  entry: CatalogPlugin | undefined,
  local: InstalledPlugin | undefined,
  isEntitled: (feature: string) => boolean,
): BlockedReason {
  // Order matters. Planned wins over everything: it does not exist yet.
  if (entry?.status === "planned") return "planned";

  if (!local) {
    // The catalog knows it, this binary does not ship it.
    if (entry?.availability === "cloud") return "cloud_only";
    return "requires_app_upgrade";
  }

  if (entry?.requires_feature && !isEntitled(entry.requires_feature)) {
    return "requires_feature";
  }

  return null;
}

export function mergePlugins(input: MergeInput): MergedPlugin[] {
  const { catalog, installed, appVersion, votes, isEntitled } = input;

  const byId = new Map<string, CatalogPlugin>(catalog.map((e) => [e.id, e]));
  const localById = new Map<string, InstalledPlugin>(installed.map((p) => [p.id, p]));
  const ids = [...new Set([...byId.keys(), ...localById.keys()])].sort();

  return ids.map((id) => {
    const entry = byId.get(id);
    const local = localById.get(id);

    const installedVersion = local?.version ?? null;
    const latestVersion = entry?.latest?.version ?? null;
    const minApp = entry?.latest?.min_app ?? null;

    const updateAvailable =
      installedVersion !== null && latestVersion !== null && gt(latestVersion, installedVersion);

    return {
      id,
      // Catalog copy wins when present, so a reworded description ships without
      // an app release. A registry-only plugin falls back to its own id.
      name: entry?.name ?? id,
      tagline: entry?.tagline ?? "",
      description: entry?.description ?? "",
      category: entry?.category ?? "other",
      status: entry?.status ?? "available",
      availability: entry?.availability ?? "oss",
      icon: entry?.icon ?? "Puzzle",
      docs: entry?.docs ?? null,
      source: entry?.source ?? null,
      screenshots: entry?.screenshots ?? [],
      installed: local !== undefined,
      installedVersion,
      latestVersion,
      updateAvailable,
      updateRequiresApp: minApp !== null && !gte(appVersion, minApp) ? minApp : null,
      enabled: local?.enabled ?? false,
      blockedReason: blockedReasonFor(entry, local, isEntitled),
      votes: votes[id] ?? 0,
    };
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/backend/src/tests/plugin-merge.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify the update badge cannot be faked**

Temporarily change `updateAvailable` to the constant `false` in `merge.ts`, run the merge test, and confirm the "a newer catalog version sets updateAvailable" test FAILS. Restore it and confirm the suite passes. Report both observations. Do not commit the temporary change, and confirm `git status` is clean before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/plugins/merge.ts packages/backend/src/tests/plugin-merge.test.ts
git commit -m "feat: merge the plugin catalog with the local registry"
```

---

### Task 5: The three routes

**Files:**
- Modify: `packages/backend/src/plugins/routes.ts`
- Create: `packages/backend/src/tests/plugin-catalog-routes.test.ts`
- Modify: `docs/features/plugins.md`

**Interfaces:**
- Consumes: `getCatalog`, `getVotes`, `postVote`, `catalogEgressEnabled` (Task 3); `mergePlugins` (Task 4); `getPluginEntitlementCheck` (Task 2); `APP_VERSION` (Task 1); the existing `getBackendPlugins` and `getEnabledPluginIds`.
- Produces: `GET /api/v1/plugins/catalog`, `POST /api/v1/plugins/catalog/refresh`, `POST /api/v1/plugins/catalog/vote`.

The existing `GET /` and `PUT /:id` keep their current shape and behaviour. This adds routes rather than reshaping them, because `GET /api/v1/plugins` is a documented endpoint and the frontend is not necessarily its only consumer.

- [ ] **Step 1: Write the failing route test**

Create `packages/backend/src/tests/plugin-catalog-routes.test.ts`. Model the app bootstrap and admin login on the existing `plugin-framework.test.ts` in the same directory; read it first and mirror its `beforeAll` setup, its test database naming convention and how it obtains an auth token.

```ts
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
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "admin-password-1";
  process.env.JWT_SECRET = "test-secret-that-is-at-least-32-chars";
  resetEnvCache();

  initDatabase(TEST_DB);
  runMigrations();
  seed();
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

const auth = { Authorization: `Bearer ${token}` };

describe("GET /api/v1/plugins/catalog", () => {
  test("returns the merged payload with provenance", async () => {
    updateSettings({ plugin_catalog_url: "" }); // snapshot only, no egress
    const res = await app.request("/api/v1/plugins/catalog", { headers: auth });
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
    const res = await app.request("/api/v1/plugins/catalog", { headers: auth });
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
    }) as typeof fetch;

    const res = await app.request("/api/v1/plugins/catalog/refresh", {
      method: "POST",
      headers: auth,
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
    let body: string | null = null;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      body = (init?.body as string) ?? null;
      return Promise.resolve(
        new Response(JSON.stringify({ count: 9, voted: true }), { status: 200 }),
      );
    }) as typeof fetch;

    const res = await app.request("/api/v1/plugins/catalog/vote", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "accounts-payable" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { count: number | null } };
    expect(json.data.count).toBe(9);
    expect(body).toContain("accounts-payable");
  });

  test("is a no-op with egress off, and opens no socket", async () => {
    updateSettings({ plugin_catalog_url: "" });
    globalThis.fetch = (() => {
      throw new Error("must not fetch with egress off");
    }) as typeof fetch;

    const res = await app.request("/api/v1/plugins/catalog/vote", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "accounts-payable" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { count: number | null } };
    expect(json.data.count).toBeNull();
  });

  test("rejects a malformed body", async () => {
    const res = await app.request("/api/v1/plugins/catalog/vote", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/backend/src/tests/plugin-catalog-routes.test.ts`
Expected: FAIL, the catalog routes 404.

- [ ] **Step 3: Add the routes to `packages/backend/src/plugins/routes.ts`**

Add these imports at the top of the file:

```ts
import { catalogEgressEnabled, getCatalog, getVotes, postVote } from "./catalog.service";
import { getPluginEntitlementCheck } from "./entitlement";
import { mergePlugins } from "./merge";
import { APP_VERSION } from "../utils/version";
```

Then add the three routes. Put them **above** the existing `PUT /:id`, so the
literal `catalog` segment is matched before any parameterised route:

```ts
// GET /api/v1/plugins/catalog: the merged view the Plugins tab renders. Any
// authenticated user may read it; only the admin toggle below writes.
pluginsAdminRoutes.get("/catalog", async (c) => {
  const [result, votes] = await Promise.all([getCatalog(), getVotes()]);
  const enabled = getEnabledPluginIds();
  const entitlementCheck = getPluginEntitlementCheck();

  const plugins = mergePlugins({
    catalog: result.catalog.plugins,
    installed: getBackendPlugins().map((p) => ({
      id: p.id,
      version: p.version,
      enabled: enabled.includes(p.id),
    })),
    appVersion: APP_VERSION,
    votes,
    // OSS ships no plans, so with no resolver installed everything is entitled.
    isEntitled: (feature) => (entitlementCheck ? entitlementCheck(feature) : true),
  });

  return c.json({
    success: true,
    data: {
      plugins,
      catalog: {
        source: result.source,
        syncedAt: result.syncedAt,
        error: result.error,
        egressEnabled: catalogEgressEnabled(),
      },
    },
  });
});

// POST /api/v1/plugins/catalog/refresh: force a re-sync, ignoring the TTL.
pluginsAdminRoutes.post("/catalog/refresh", async (c) => {
  const user = c.get("user") as { is_admin?: boolean } | undefined;
  if (!user?.is_admin) return c.json({ success: false, error: "Forbidden" }, 403);

  const result = await getCatalog({ force: true });
  return c.json({
    success: true,
    data: { source: result.source, syncedAt: result.syncedAt, error: result.error },
  });
});

const voteSchema = z.object({ id: z.string().min(1).max(64) });

// POST /api/v1/plugins/catalog/vote: register interest in a planned plugin.
// Proxied so a self-hosted browser never talks to inkvoice.app directly, and so
// clearing plugin_catalog_url disables voting as a consequence.
pluginsAdminRoutes.post("/catalog/vote", async (c) => {
  const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const count = await postVote(parsed.data.id);
  return c.json({ success: true, data: { count } });
});
```

Note that `z`, `getBackendPlugins` and `getEnabledPluginIds` are already imported in this file; do not duplicate the imports.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `bun test packages/backend/src/tests/plugin-catalog-routes.test.ts`
Expected: PASS, 8 tests.

If `GET /api/v1/plugins/catalog` returns the plugin-list payload instead of the catalog, the route ordering is wrong; move the catalog routes above `PUT /:id` and any other parameterised route in the file.

- [ ] **Step 5: Update the feature documentation**

`docs/features/plugins.md` is the user-facing description of this system and is currently 41 lines describing the old flat tab. Add a section covering:

- What the catalog is, and that plugin metadata now comes from a public catalog at `https://inkvoice.app/plugins/catalog.v1.json`.
- That the app fetches it **server-side**, on a 6h TTL, and ships a bundled snapshot so the tab works with no internet at all.
- **How to turn it off**: set the `plugin_catalog_url` setting to an empty string. State plainly that this stops all catalog egress including demand votes, and that the tab then shows the bundled snapshot only.
- That the update indicator means "a newer version of this plugin exists, upgrade Inkvoice to get it", never an in-place plugin update.
- The five `blockedReason` values and what each means to a user.

Keep the file's existing tone and structure. No dashes.

- [ ] **Step 6: Run the whole suite, lint and typecheck**

```bash
bun run lint && bun run typecheck && bun test
```

Expected: all clean. This is the same chain CI runs.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/plugins/routes.ts packages/backend/src/tests/plugin-catalog-routes.test.ts docs/features/plugins.md
git commit -m "feat: plugin catalog, refresh and vote endpoints"
```

---

## Definition of done

- `bun run lint && bun run typecheck && bun test` all pass.
- `GET /api/v1/plugins/catalog` returns the merged payload with correct `installed`, `enabled`, `updateAvailable`, `updateRequiresApp`, `blockedReason` and `votes` for every entry, and reports its own provenance.
- With `plugin_catalog_url` set to the empty string, no outbound socket is opened on any path, and the endpoint still returns a full catalog from the snapshot.
- With the remote unreachable, the endpoint returns 200 with `source: "cache"` or `"snapshot"` and a populated `error`, never a 5xx.
- `registerBackendPlugin({ id: "catalog" })` throws.
- `GET /api/v1/plugins` and `PUT /api/v1/plugins/:id` behave exactly as before.
- `docs/features/plugins.md` documents the catalog and how to switch it off.

## Manual verification before calling this done

Automated tests never exercise a real fetch. Once `pigontech/inkvoice-plugins` is published, run the backend and confirm against the live URL:

```bash
bun run dev:backend
```

Then, with an admin token:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/plugins/catalog | python3 -m json.tool | head -40
```

Confirm `catalog.source` is `remote` on the first call and `cache` on the second, and that `syncedAt` is populated. Until that repo is published, the endpoint correctly reports `source: "snapshot"` with an error, which is the designed behaviour and not a bug.

## What this plan does NOT do

The frontend is a separate plan. Nothing here changes the Plugins tab, the store, the routes in `App.tsx`, or any component. After this plan lands, the new endpoint exists and is tested but nothing calls it, and the Plugins tab behaves exactly as it does today. That is intentional: the backend is independently shippable and independently reviewable.

Also out of scope, per the spec: dynamic or third-party plugin installation, in-place plugin updates, per-plugin permissions beyond the existing admin gate, and localised catalog content.
