# Plugin Catalog Frontend (spec C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Plugins settings tab into the master/detail surface the spec defines: the merged catalog from `GET /api/v1/plugins/catalog` with search, category and status filters, grid/list layouts, provenance footer, a detail view at `/settings/plugins/:pluginId`, and the demand vote.

**Architecture:** A pure logic module (`plugins/catalog.ts`) owns types and every testable decision (filtering, enabled-id derivation, vote gating, footer state, view persistence, chip keys). The Zustand store switches to the merged endpoint and keeps its `enabled`/`loaded`/`ensureFetched` contract so the nav gate and PluginGuard are untouched. The tab renders master or detail from the route param. No new runtime or dev dependencies.

**Tech Stack:** React 19, Zustand, react-router v7, Tailwind v4, existing shadcn-style ui kit, `bun:test` (logic-only, no DOM).

**Spec:** `docs/superpowers/specs/2026-08-31-plugin-catalog-app-design.md` (Part 2). The backend endpoints this consumes are already implemented and reviewed (spec B, commits `f5dc927..7d00094`).

## Owner decisions that shape this plan

- **Testing is logic-only** (ruled 2026-09-01). The spec's Testing section lists seven render-based `.test.tsx` cases; this plan replaces them with logic equivalents on the pure helpers plus a store test with a stubbed `fetch`. No DOM, no testing-library, no `.test.tsx`, no new dev dependencies. Bare `bun test` picks up `packages/frontend/src/**/*.test.ts` (precedent: `plugins-bootstrap.test.ts`).
- **No new dependencies.** The switch component is a plain button with `role="switch"`, matching the kit's dependency-free `ui/checkbox.tsx` style.
- **Spec 2.3's footer example names `inkvoice.app` verbatim**; the footer renders that label even though a self-hoster could point `plugin_catalog_url` elsewhere. A host-aware label is a deferred nicety, not a spec requirement.

## Global Constraints

- **blockedReason enum:** `null | "planned" | "cloud_only" | "requires_feature" | "requires_app_upgrade"`. Values arrive from the backend; the frontend never invents new ones.
- **Categories closed enum:** `billing`, `compliance`, `productivity`, `integrations`, `reporting` (spec A `CATEGORIES`).
- **View toggle persists to `localStorage` key `inkvoice.plugins.view`**, values `grid` | `list`, default `grid`.
- **i18n:** new UI strings go in `packages/frontend/src/plugins/i18n.ts` under the `plugins` namespace for all five languages (en, tr, de, es, fr). Catalog-sourced text (name, tagline, description) is English-only by design and rendered as-is. Never hardcode user-facing strings in components; use `t("plugins.key")`.
- **`nav.extensions` becomes `nav.plugins`** in this repo: the five dictionary files, the sidebar fallback, the nav-registry default, and the time-tracker registration. (Overlay nav registrations send the old key until spec D lands; the sidebar would then render the raw key on cloud builds. Spec D fixes that before the next cloud sync.)
- **Reserved plugin id `catalog`**: detail paths are `/settings/plugins/<pluginId>`; the catalog itself is not an entry and never renders a detail view.
- **API shape** via `pluginFetch` (`plugins/api.ts`): `{ success: true, data: ... }`, throws `Error(message)` on failure. Settings writes go through the OSS `api.updateSettings` (`api/client.ts`).
- **No em dashes or en dashes** in prose or code. Commit messages: title line only, no body, no `Co-Authored-By` trailer.
- **Frontend tests are logic-only**: files end `.test.ts` (not `.tsx`), import no component, render nothing.

## The merged payload (backend contract, implemented in spec B)

`GET /api/v1/plugins/catalog` returns:

```json
{ "success": true, "data": { "plugins": [ "/* MergedPlugin entries */" ], "catalog": { "source": "remote|cache|snapshot", "syncedAt": "ISO|null", "error": "string|null", "egressEnabled": true } } }
```

MergedPlugin entry fields: `id, name, tagline, description, category, status ("available"|"planned"), availability ("oss"|"cloud"|"both"), icon, docs (string|null), source (string|null), screenshots, installed, installedVersion, latestVersion, updateAvailable, updateRequiresApp, enabled, blockedReason, votes`.

Other endpoints used: `POST /api/v1/plugins/catalog/refresh` (forces a server-side re-sync, returns provenance only), `POST /api/v1/plugins/catalog/vote` body `{ id }` returns `{ data: { count: number | null } }`, `PUT /api/v1/plugins/:id` body `{ enabled }` returns `{ data: { enabled: string[] } }`, `PUT /api/v1/settings` accepts `plugin_catalog_url` (empty string is the off switch).

---

### Task 1: Pure view logic, icon map, switch

**Files:**
- Create: `packages/frontend/src/plugins/catalog.ts`
- Create: `packages/frontend/src/plugins/icon-map.ts`
- Create: `packages/frontend/src/components/ui/switch.tsx`
- Create: `packages/frontend/src/tests/plugins-catalog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CatalogPluginEntry`, `CatalogProvenance`, `CatalogResponse`, `BlockedReason`, `CATEGORIES`, `StatusFilter`, `PluginFilters`, `deriveEnabledIds(entries)`, `filterPlugins(entries, filters)`, `canVote(entry, egressEnabled)`, `minutesSince(syncedAt, now)`, `FooterState`, `footerState(provenance, now)`, `blockedChipKey(reason)`, `PluginsView`, `VIEW_STORAGE_KEY`, `loadViewPreference()`, `saveViewPreference(view)`, `RELEASES_URL` from `plugins/catalog.ts`; `catalogIcon(name): LucideIcon` from `plugins/icon-map.ts`; `Switch` from `components/ui/switch.tsx`. Tasks 2, 5 and 6 build on these.

- [ ] **Step 1: Write the failing logic test**

Create `packages/frontend/src/tests/plugins-catalog.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  blockedChipKey,
  canVote,
  deriveEnabledIds,
  filterPlugins,
  footerState,
  loadViewPreference,
  minutesSince,
  saveViewPreference,
  VIEW_STORAGE_KEY,
  type CatalogPluginEntry,
  type CatalogProvenance,
} from "../plugins/catalog";

function entry(over: Partial<CatalogPluginEntry> = {}): CatalogPluginEntry {
  return {
    id: "time-tracker",
    name: "Time Tracker",
    tagline: "Track billable hours.",
    description: "Body.",
    category: "productivity",
    status: "available",
    availability: "both",
    icon: "Clock",
    docs: null,
    source: null,
    screenshots: [],
    installed: true,
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    updateRequiresApp: null,
    enabled: true,
    blockedReason: null,
    votes: 0,
    ...over,
  };
}

function prov(over: Partial<CatalogProvenance> = {}): CatalogProvenance {
  return { source: "remote", syncedAt: null, error: null, egressEnabled: true, ...over };
}

const fakeStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
};

describe("deriveEnabledIds", () => {
  test("keeps installed and enabled entries only", () => {
    expect(
      deriveEnabledIds([
        entry(),
        entry({ id: "off", enabled: false }),
        entry({ id: "planned", installed: false, enabled: false, status: "planned" }),
      ]),
    ).toEqual(["time-tracker"]);
  });
});

describe("filterPlugins", () => {
  const entries = [
    entry(),
    entry({ id: "off", enabled: false }),
    entry({ id: "peppol", name: "Peppol", category: "compliance", installed: false, enabled: false, blockedReason: "cloud_only" }),
    entry({ id: "planned-one", name: "Accounts Payable", status: "planned", installed: false, enabled: false, blockedReason: "planned", votes: 12 }),
  ];

  test("no filters returns everything", () => {
    expect(filterPlugins(entries, { query: "", category: "all", status: "all" })).toHaveLength(4);
  });

  test("search is a case-insensitive substring over name, tagline and category", () => {
    expect(filterPlugins(entries, { query: "time tra", category: "all", status: "all" }).map((p) => p.id)).toEqual(["time-tracker"]);
    expect(filterPlugins(entries, { query: "PEPPOL", category: "all", status: "all" }).map((p) => p.id)).toEqual(["peppol"]);
    expect(filterPlugins(entries, { query: "compliance", category: "all", status: "all" }).map((p) => p.id)).toEqual(["peppol"]);
  });

  test("category filter matches exactly", () => {
    expect(filterPlugins(entries, { query: "", category: "compliance", status: "all" }).map((p) => p.id)).toEqual(["peppol"]);
  });

  test("status chips: enabled shows enabled entries only", () => {
    expect(filterPlugins(entries, { query: "", category: "all", status: "enabled" }).map((p) => p.id)).toEqual(["time-tracker"]);
  });

  test("status chips: disabled shows installed but not enabled, never planned", () => {
    expect(filterPlugins(entries, { query: "", category: "all", status: "disabled" }).map((p) => p.id)).toEqual(["off"]);
  });

  test("status chips: planned shows planned entries only", () => {
    expect(filterPlugins(entries, { query: "", category: "all", status: "planned" }).map((p) => p.id)).toEqual(["planned-one"]);
  });

  test("search and filters compose", () => {
    expect(filterPlugins(entries, { query: "payable", category: "all", status: "planned" }).map((p) => p.id)).toEqual(["planned-one"]);
    expect(filterPlugins(entries, { query: "payable", category: "compliance", status: "planned" })).toEqual([]);
  });
});

describe("canVote", () => {
  test("planned with egress on is votable", () => {
    expect(canVote(entry({ status: "planned", installed: false, enabled: false }), true)).toBe(true);
  });
  test("egress off hides the vote affordance entirely", () => {
    expect(canVote(entry({ status: "planned", installed: false, enabled: false }), false)).toBe(false);
  });
  test("non-planned entries never show a vote button", () => {
    expect(canVote(entry(), true)).toBe(false);
  });
});

describe("minutesSince", () => {
  test("null for null or unparseable input", () => {
    expect(minutesSince(null, 1000)).toBeNull();
    expect(minutesSince("not a date", 1000)).toBeNull();
  });
  test("floors to whole minutes and clamps future timestamps", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    expect(minutesSince("2026-09-01T11:59:30Z", now)).toBe(0);
    expect(minutesSince("2026-09-01T11:30:00Z", now)).toBe(30);
    expect(minutesSince("2026-08-31T12:00:00Z", now)).toBe(1440);
    expect(minutesSince("2026-09-01T12:00:01Z", now)).toBe(0);
  });
});

describe("footerState", () => {
  test("egress off wins over everything", () => {
    expect(footerState(prov({ egressEnabled: false, source: "snapshot", error: "HTTP 404" }), 0)).toEqual({ kind: "off" });
  });
  test("a failed sync on the snapshot path reports the reason", () => {
    expect(footerState(prov({ source: "snapshot", error: "HTTP 404" }), 0)).toEqual({ kind: "failed", reason: "HTTP 404" });
  });
  test("a synced catalog reports its age in minutes for both remote and cache", () => {
    const syncedAt = "2026-09-01T10:00:00Z";
    expect(footerState(prov({ source: "cache", syncedAt }), Date.parse("2026-09-01T12:00:00Z"))).toEqual({ kind: "synced", ageMinutes: 120 });
    expect(footerState(prov({ source: "remote", syncedAt }), Date.parse("2026-09-01T12:00:00Z")).kind).toBe("synced");
  });
});

describe("blockedChipKey", () => {
  test("maps each blocked reason to its key and null to null", () => {
    expect(blockedChipKey(null)).toBeNull();
    expect(blockedChipKey("planned")).toBe("plugins.chip_planned");
    expect(blockedChipKey("cloud_only")).toBe("plugins.chip_cloud_only");
    expect(blockedChipKey("requires_feature")).toBe("plugins.chip_requires_feature");
    expect(blockedChipKey("requires_app_upgrade")).toBe("plugins.chip_requires_app_upgrade");
  });
});

describe("view preference", () => {
  const real = (globalThis as { localStorage?: unknown }).localStorage;
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = real;
  });

  test("defaults to grid when localStorage is absent (bun has none)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadViewPreference()).toBe("grid");
  });

  test("persists list across loads", () => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeStorage();
    saveViewPreference("list");
    expect(loadViewPreference()).toBe("list");
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe("list");
    saveViewPreference("grid");
    expect(loadViewPreference()).toBe("grid");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/frontend/src/tests/plugins-catalog.test.ts`
Expected: FAIL, cannot resolve `../plugins/catalog`.

- [ ] **Step 3: Write `packages/frontend/src/plugins/catalog.ts`**

```ts
// Pure view logic for the Plugins tab. No React, no network, no component
// imports, so bun can exercise every branch headless. The types mirror the
// backend's merged payload (packages/backend/src/plugins/merge.ts and
// catalog.service.ts), which is the shape of record.

export type BlockedReason =
  | null
  | "planned"
  | "cloud_only"
  | "requires_feature"
  | "requires_app_upgrade";

export interface CatalogScreenshot {
  url: string;
  alt: string;
}

export interface CatalogPluginEntry {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  status: "available" | "planned";
  availability: "oss" | "cloud" | "both";
  /** Lucide icon name from the catalog; resolve through icon-map.ts. */
  icon: string;
  docs: string | null;
  source: string | null;
  screenshots: CatalogScreenshot[];
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateRequiresApp: string | null;
  enabled: boolean;
  blockedReason: BlockedReason;
  votes: number;
}

export interface CatalogProvenance {
  source: "remote" | "cache" | "snapshot";
  syncedAt: string | null;
  error: string | null;
  egressEnabled: boolean;
}

export interface CatalogResponse {
  data: {
    plugins: CatalogPluginEntry[];
    catalog: CatalogProvenance;
  };
}

/** Closed category enum from the catalog contract (spec A). */
export const CATEGORIES = [
  "billing",
  "compliance",
  "productivity",
  "integrations",
  "reporting",
] as const;

export type StatusFilter = "all" | "enabled" | "disabled" | "planned";

export interface PluginFilters {
  query: string;
  /** "all" or one of CATEGORIES. */
  category: string;
  status: StatusFilter;
}

/** The ids nav gating and PluginGuard consume. Semantics identical to the
 *  pre-catalog store's `enabled` array. */
export function deriveEnabledIds(entries: CatalogPluginEntry[]): string[] {
  return entries.filter((p) => p.installed && p.enabled).map((p) => p.id);
}

/** Client-side narrowing is deliberate: the catalog is a few dozen entries
 *  already in memory. Search covers name, tagline and category. */
export function filterPlugins(
  entries: CatalogPluginEntry[],
  filters: PluginFilters,
): CatalogPluginEntry[] {
  const q = filters.query.trim().toLowerCase();
  return entries.filter((p) => {
    if (filters.category !== "all" && p.category !== filters.category) return false;
    if (filters.status === "enabled" && !p.enabled) return false;
    if (filters.status === "disabled" && !(p.installed && !p.enabled)) return false;
    if (filters.status === "planned" && p.status !== "planned") return false;
    if (q) {
      const hay = `${p.name}\n${p.tagline}\n${p.category}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** A vote affordance exists only for planned entries while egress is on.
 *  A vote that cannot be sent must not be offered. */
export function canVote(entry: CatalogPluginEntry, egressEnabled: boolean): boolean {
  return entry.status === "planned" && egressEnabled;
}

export const RELEASES_URL = "https://github.com/pigontech/inkvoice/releases";

/** Whole minutes between syncedAt and now, floored, null when unknown. */
export function minutesSince(syncedAt: string | null, now: number): number | null {
  if (!syncedAt) return null;
  const at = Date.parse(syncedAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 60000));
}

/** Which footer line the tab renders. Exactly the spec's three provenance
 *  states; nothing else may render. */
export type FooterState =
  | { kind: "synced"; ageMinutes: number | null }
  | { kind: "failed"; reason: string }
  | { kind: "off" };

export function footerState(p: CatalogProvenance, now: number): FooterState {
  if (!p.egressEnabled) return { kind: "off" };
  if (p.source === "snapshot") {
    return { kind: "failed", reason: p.error ?? "" };
  }
  return { kind: "synced", ageMinutes: minutesSince(p.syncedAt, now) };
}

/** i18n key for the reason chip. Null when there is no blocker, so the caller
 *  renders the enable switch instead. */
export function blockedChipKey(reason: BlockedReason): string | null {
  switch (reason) {
    case null:
      return null;
    case "planned":
      return "plugins.chip_planned";
    case "cloud_only":
      return "plugins.chip_cloud_only";
    case "requires_feature":
      return "plugins.chip_requires_feature";
    case "requires_app_upgrade":
      return "plugins.chip_requires_app_upgrade";
  }
}

export type PluginsView = "grid" | "list";

export const VIEW_STORAGE_KEY = "inkvoice.plugins.view";

export function loadViewPreference(): PluginsView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function saveViewPreference(view: PluginsView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Private mode or non-browser env: the preference simply does not persist.
  }
}
```

- [ ] **Step 4: Run the logic test to verify it passes**

Run: `bun test packages/frontend/src/tests/plugins-catalog.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Write `packages/frontend/src/plugins/icon-map.ts`**

```ts
// Catalog entries carry a lucide icon NAME (validated in the catalog repo
// against the lucide intersection). Importing every lucide icon to resolve
// names dynamically would ship the whole set to the client for one lookup,
// so this map is curated: add an entry when a published plugin uses a new
// icon. Unknown names fall back to Puzzle.
import { Clock, FileCheck, Network, Puzzle, Receipt, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Clock,
  FileCheck,
  Network,
  Receipt,
};

export function catalogIcon(name: string): LucideIcon {
  return ICONS[name] ?? Puzzle;
}
```

- [ ] **Step 6: Write `packages/frontend/src/components/ui/switch.tsx`**

```tsx
// Plain switch control, matching the kit's dependency-free checkbox.tsx style
// (no Radix, no new dependency). Enable/disable is a switch affordance.
import { cn } from "@/lib/utils";

interface SwitchProps {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label"?: string;
  className?: string;
}

export function Switch({
  checked,
  disabled,
  onCheckedChange,
  className,
  ...rest
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
```

- [ ] **Step 7: Typecheck, lint, run the frontend tests**

Run: `bun run typecheck && bun run lint && bun test packages/frontend`
Expected: clean; all tests pass including the new 19 and the existing `plugins-bootstrap.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/plugins/catalog.ts packages/frontend/src/plugins/icon-map.ts packages/frontend/src/components/ui/switch.tsx packages/frontend/src/tests/plugins-catalog.test.ts
git commit -m "feat: plugins tab view logic, icon map and switch"
```

---

### Task 2: Store migration to the catalog endpoint

**Files:**
- Modify: `packages/frontend/src/plugins/use-plugins.store.ts`
- Create: `packages/frontend/src/tests/plugins-store.test.ts`

**Interfaces:**
- Consumes: `CatalogPluginEntry`, `CatalogProvenance`, `CatalogResponse`, `deriveEnabledIds` from Task 1.
- Produces: the store shape Tasks 5 and 6 consume: `enabled: string[]`, `entries: CatalogPluginEntry[]`, `provenance: CatalogProvenance | null`, `loaded`, `loading`, `error`, `ensureFetched()`, `refresh(opts?: { force?: boolean })`, `isEnabled(id)`, `setEnabled(id, enabled)`, `vote(id): Promise<number | null>`, `turnOff(): Promise<void>`.

The nav gate (`install-nav-gate.ts`) and `PluginGuard.tsx` read only `enabled`, `loaded`, `ensureFetched` from this store. Those three keep their exact semantics, so neither file changes.

- [ ] **Step 1: Write the failing store test**

Create `packages/frontend/src/tests/plugins-store.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { usePluginsStore } from "../plugins/use-plugins.store";
import type { CatalogPluginEntry, CatalogResponse } from "../plugins/catalog";

function entry(over: Partial<CatalogPluginEntry> = {}): CatalogPluginEntry {
  return {
    id: "time-tracker",
    name: "Time Tracker",
    tagline: "Track billable hours.",
    description: "Body.",
    category: "productivity",
    status: "available",
    availability: "both",
    icon: "Clock",
    docs: null,
    source: null,
    screenshots: [],
    installed: true,
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    updateRequiresApp: null,
    enabled: true,
    blockedReason: null,
    votes: 0,
    ...over,
  };
}

const CATALOG_RESPONSE: CatalogResponse = {
  data: {
    plugins: [
      entry(),
      entry({ id: "peppol", installed: false, enabled: false, blockedReason: "cloud_only" }),
      entry({ id: "planned-one", status: "planned", installed: false, enabled: false, blockedReason: "planned", votes: 3 }),
    ],
    catalog: { source: "remote", syncedAt: "2026-09-01T00:00:00.000Z", error: null, egressEnabled: true },
  },
};

const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(routes: [string, unknown, number?][]) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, init });
    for (const [match, body, code = 200] of routes) {
      if (url === match || url.endsWith(match)) {
        return Promise.resolve(json(code, body));
      }
    }
    return Promise.resolve(json(404, { success: false, error: "not found" }));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
  usePluginsStore.setState({
    enabled: [],
    entries: [],
    provenance: null,
    loaded: false,
    loading: false,
    error: null,
  });
});

describe("plugins store on the catalog endpoint", () => {
  test("refresh fetches /plugins/catalog and derives enabled ids", async () => {
    stubFetch([["/api/v1/plugins/catalog", CATALOG_RESPONSE]]);
    await usePluginsStore.getState().refresh();
    const s = usePluginsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.error).toBeNull();
    expect(s.entries.map((p) => p.id)).toEqual(["time-tracker", "peppol", "planned-one"]);
    expect(s.enabled).toEqual(["time-tracker"]);
    expect(s.provenance?.source).toBe("remote");
    expect(calls[0]?.url).toContain("/api/v1/plugins/catalog");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
  });

  test("refresh with force POSTs the refresh endpoint before the GET", async () => {
    stubFetch([
      ["/api/v1/plugins/catalog/refresh", { success: true, data: { source: "remote" } }],
      ["/api/v1/plugins/catalog", CATALOG_RESPONSE],
    ]);
    await usePluginsStore.getState().refresh({ force: true });
    expect(calls.map((c) => c.url.replace("http://localhost", "").split("?")[0])).toEqual([
      "/api/v1/plugins/catalog/refresh",
      "/api/v1/plugins/catalog",
    ]);
  });

  test("a failed refresh marks loaded and records the error, keeping guards honest", async () => {
    globalThis.fetch = (() => Promise.resolve(json(500, { success: false, error: "boom" }))) as typeof fetch;
    await usePluginsStore.getState().refresh();
    const s = usePluginsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.error).toBe("boom");
    expect(s.entries).toEqual([]);
    expect(s.enabled).toEqual([]);
  });

  test("setEnabled PUTs /plugins/:id and patches the entry in place", async () => {
    stubFetch([
      ["/api/v1/plugins/catalog", CATALOG_RESPONSE],
      ["/api/v1/plugins/time-tracker", { success: true, data: { enabled: [] } }],
    ]);
    await usePluginsStore.getState().refresh();
    await usePluginsStore.getState().setEnabled("time-tracker", false);
    const s = usePluginsStore.getState();
    expect(s.enabled).toEqual([]);
    expect(s.entries.find((e) => e.id === "time-tracker")?.enabled).toBe(false);
    expect(calls[1]?.init?.method).toBe("PUT");
  });

  test("vote POSTs the id and patches the entry's votes; a failed vote leaves it alone", async () => {
    stubFetch([
      ["/api/v1/plugins/catalog", CATALOG_RESPONSE],
      ["/api/v1/plugins/catalog/vote", { success: true, data: { count: 9, voted: true } }],
    ]);
    await usePluginsStore.getState().refresh();
    const count = await usePluginsStore.getState().vote("planned-one");
    expect(count).toBe(9);
    expect(usePluginsStore.getState().entries.find((e) => e.id === "planned-one")?.votes).toBe(9);
    const voteCalls = calls.filter((c) => c.url.endsWith("/plugins/catalog/vote"));
    expect(JSON.parse(String(voteCalls[0]?.init?.body))).toEqual({ id: "planned-one" });

    // A second vote whose request fails returns null and keeps the old count.
    stubFetch([["/api/v1/plugins/catalog/vote", { success: false, error: "down" }, 500]]);
    const again = await usePluginsStore.getState().vote("planned-one");
    expect(again).toBeNull();
    expect(usePluginsStore.getState().entries.find((e) => e.id === "planned-one")?.votes).toBe(9);
  });

  test("turnOff clears plugin_catalog_url then refetches the snapshot state", async () => {
    stubFetch([
      ["/api/v1/settings", { success: true, data: {} }],
      [
        "/api/v1/plugins/catalog",
        {
          data: {
            plugins: [entry()],
            catalog: { source: "snapshot", syncedAt: null, error: null, egressEnabled: false },
          },
        },
      ],
    ]);
    await usePluginsStore.getState().turnOff();
    const putCall = calls.find((c) => c.url.endsWith("/api/v1/settings"));
    expect(putCall?.init?.method).toBe("PUT");
    expect(JSON.parse(String(putCall?.init?.body))).toEqual({ plugin_catalog_url: "" });
    const s = usePluginsStore.getState();
    expect(s.provenance?.egressEnabled).toBe(false);
    expect(s.provenance?.source).toBe("snapshot");
  });
});
```

- [ ] **Step 2: Run it to verify it fails or misbehaves**

Run: `bun test packages/frontend/src/tests/plugins-store.test.ts`
Expected: FAIL (the old store has no `entries`/`provenance`/`vote`/`turnOff`, and `refresh` still calls `/plugins`).

- [ ] **Step 3: Rewrite `packages/frontend/src/plugins/use-plugins.store.ts`**

Replace the file's content with:

```ts
// Per-tenant plugin state, driven by the merged catalog endpoint
// GET /api/v1/plugins/catalog (spec: docs/superpowers/specs/2026-08-31-plugin-
// catalog-app-design.md, 2.2). Holds the full merged entry list plus catalog
// provenance. Drives the nav-visibility gate, PluginGuard, and the admin
// Plugins settings tab; those three consume enabled/loaded/ensureFetched with
// semantics identical to the pre-catalog store. Enablement writes still go
// through PUT /api/v1/plugins/:id and patch the entry in place. Fetched
// lazily once the authenticated shell mounts.

import { create } from "zustand";
import { api } from "@/api/client";
import { pluginFetch } from "./api";
import { deriveEnabledIds, type CatalogPluginEntry, type CatalogProvenance } from "./catalog";

interface CatalogResponse {
  data: {
    plugins: CatalogPluginEntry[];
    catalog: CatalogProvenance;
  };
}

interface PluginsState {
  /** Ids of installed and enabled plugins. Nav gating and PluginGuard read
   *  this; unchanged semantics from the pre-catalog store. */
  enabled: string[];
  entries: CatalogPluginEntry[];
  provenance: CatalogProvenance | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Fetch once; no-op if already loaded or in flight. */
  ensureFetched: () => void;
  /** Fetch the merged catalog. force first POSTs the admin refresh endpoint
   *  so the server-side TTL is bypassed. */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  isEnabled: (id: string) => boolean;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Register demand for a planned plugin. Returns the new count, or null
   *  when egress is off or the request failed. */
  vote: (id: string) => Promise<number | null>;
  /** The self-hoster off switch: clears plugin_catalog_url, then refetches so
   *  provenance reflects the snapshot-only state. */
  turnOff: () => Promise<void>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  enabled: [],
  entries: [],
  provenance: null,
  loaded: false,
  loading: false,
  error: null,

  ensureFetched: () => {
    const s = get();
    if (s.loaded || s.loading) return;
    void s.refresh();
  },

  refresh: async (opts = {}) => {
    set({ loading: true });
    try {
      if (opts.force) {
        await pluginFetch("/plugins/catalog/refresh", { method: "POST" });
      }
      const res = await pluginFetch<CatalogResponse>("/plugins/catalog");
      const entries = res.data.plugins;
      set({
        entries,
        provenance: res.data.catalog,
        enabled: deriveEnabledIds(entries),
        loaded: true,
        loading: false,
        error: null,
      });
    } catch (err) {
      // Mark loaded even on failure so guards resolve (deny) instead of spinning.
      set({ loading: false, loaded: true, error: (err as Error).message });
    }
  },

  isEnabled: (id) => get().enabled.includes(id),

  setEnabled: async (id, enabled) => {
    const res = await pluginFetch<{ data: { enabled: string[] } }>(`/plugins/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    const enabledIds = res.data.enabled;
    set((s) => ({
      enabled: enabledIds,
      entries: s.entries.map((e) => (e.id === id ? { ...e, enabled } : e)),
    }));
  },

  vote: async (id) => {
    try {
      const res = await pluginFetch<{ data: { count: number | null } }>("/plugins/catalog/vote", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      const count = res.data.count;
      if (count !== null) {
        set((s) => ({
          entries: s.entries.map((e) => (e.id === id ? { ...e, votes: count } : e)),
        }));
      }
      return count;
    } catch {
      return null;
    }
  },

  turnOff: async () => {
    await api.updateSettings({ plugin_catalog_url: "" });
    await get().refresh();
  },
}));
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `bun test packages/frontend/src/tests/plugins-store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the framework tests still pass**

Run: `bun test packages/frontend/src/tests/plugins-bootstrap.test.ts packages/backend/src/tests/plugin-framework.test.ts`
Expected: PASS. The nav gate and PluginGuard consume `enabled`/`loaded`/`ensureFetched`, unchanged by this rewrite.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/plugins/use-plugins.store.ts packages/frontend/src/tests/plugins-store.test.ts
git commit -m "feat: plugins store moves to the merged catalog endpoint"
```

---

### Task 3: Registry settings slot, i18n keys, sidebar rename

**Files:**
- Modify: `packages/frontend/src/plugins/registry.ts`
- Modify: `packages/frontend/src/plugins/i18n.ts`
- Modify: `packages/frontend/src/i18n/en.ts:87`, `tr.ts:89`, `es.ts:90`, `de.ts:94`, `fr.ts:90` (rename the `extensions` key to `plugins`)
- Modify: `packages/frontend/src/nav-registry.ts:24`, `packages/frontend/src/components/layout/Sidebar.tsx:95` and `:109` (default section key)
- Modify: `packages/frontend/src/plugins/time-tracker/index.tsx:30` (section key)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FrontendPlugin.settings?: ComponentType` (Task 6 renders it); i18n keys under `plugins.*` used verbatim by Tasks 5 and 6; `nav.plugins` replaces `nav.extensions` everywhere in this repo.

- [ ] **Step 1: Add the settings slot to the registry**

In `packages/frontend/src/plugins/registry.ts`, add to the `FrontendPlugin` interface, directly after `icon`:

```ts
  /** Rendered in the plugin's detail view at /settings/plugins/<id>.
   *  Plugins must not register their own top-level settings tab. */
  settings?: ComponentType;
```

- [ ] **Step 2: Rename the nav section key**

In each of the five dictionaries, rename the key `extensions` under `nav` to `plugins`, keeping the value for en and tr and using "Plugins" for es, de and fr (the tab label already reads Plugins there):

- `packages/frontend/src/i18n/en.ts:87`: `extensions: "Extensions",` becomes `plugins: "Plugins",`
- `packages/frontend/src/i18n/tr.ts:89`: `extensions: "Eklentiler",` becomes `plugins: "Eklentiler",`
- `packages/frontend/src/i18n/es.ts:90`: `extensions: "Extensiones",` becomes `plugins: "Plugins",`
- `packages/frontend/src/i18n/de.ts:94`: `extensions: "Erweiterungen",` becomes `plugins: "Plugins",`
- `packages/frontend/src/i18n/fr.ts:90`: `extensions: "Extensions",` becomes `plugins: "Plugins",`

Then update the three code references to the key:

- `packages/frontend/src/nav-registry.ts:24`: the default `"nav.extensions"` becomes `"nav.plugins"` (update the comment text accordingly).
- `packages/frontend/src/components/layout/Sidebar.tsx:109` (and the comment at line 95): the fallback key `"nav.extensions"` becomes `"nav.plugins"`.
- `packages/frontend/src/plugins/time-tracker/index.tsx:30`: `section: "nav.extensions"` becomes `section: "nav.plugins"`.

- [ ] **Step 3: Extend `plugins/i18n.ts` with the catalog keys, all five languages**

Replace the whole file with the block below. The eight existing keys (`tab`, `title`, `description`, `empty`, `enable`, `disable`, `enabled_toast`, `disabled_toast`) keep their current values in all five languages; everything else is new:

```ts
// Plugin-framework UI strings (the admin Plugins management tab). Merged into
// the OSS dictionaries at import time via the registerTranslations hook.
// Catalog-sourced text (name, tagline, description) is English-only by design
// in schema v1 and rendered as-is; only these chrome strings are translated.

import { registerTranslations } from "@/i18n";

registerTranslations("en", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Enable or disable optional extensions for your workspace.",
    empty: "No plugins available.",
    enable: "Enable",
    disable: "Disable",
    enabled_toast: "Plugin enabled",
    disabled_toast: "Plugin disabled",
    search_placeholder: "Search plugins",
    filter_all: "All categories",
    filter_billing: "Billing",
    filter_compliance: "Compliance",
    filter_productivity: "Productivity",
    filter_integrations: "Integrations",
    filter_reporting: "Reporting",
    status_all: "All",
    status_enabled: "Enabled",
    status_disabled: "Disabled",
    status_planned: "Planned",
    view_grid: "Grid",
    view_list: "List",
    chip_planned: "Planned",
    chip_cloud_only: "Cloud only",
    chip_requires_feature: "Plan required",
    chip_requires_app_upgrade: "Update Inkvoice",
    update_badge: "Update available",
    installed_version: "Installed",
    latest_version: "Latest",
    back: "Back to plugins",
    docs_link: "Documentation",
    source_link: "Source",
    vote_button: "I want this",
    votes_count: "{{count}} votes",
    update_banner: "Version {{version}} is available. Upgrade Inkvoice to {{app}} or newer to get it.",
    update_banner_simple: "Version {{version}} is available. Upgrade Inkvoice to get it.",
    view_release: "Release notes",
    footer_synced: "Catalog synced {{age}}",
    footer_off: "Remote catalog is turned off.",
    footer_failed: "Using bundled catalog. Last sync failed: {{reason}}",
    footer_refresh: "Refresh",
    footer_turn_off: "Turn off",
    time_just_now: "just now",
    time_minutes_ago: "{{count}} min ago",
    time_hours_ago: "{{count}} h ago",
    time_days_ago: "{{count}} d ago",
    detail_not_found: "This plugin is not in the catalog.",
    no_matches: "No plugins match the current search and filters.",
    clear_filters: "Clear filters",
  },
});

registerTranslations("tr", {
  plugins: {
    tab: "Eklentiler",
    title: "Eklentiler",
    description: "Çalışma alanınız için isteğe bağlı eklentileri açın veya kapatın.",
    empty: "Kullanılabilir eklenti yok.",
    enable: "Etkinleştir",
    disable: "Devre dışı bırak",
    enabled_toast: "Eklenti etkinleştirildi",
    disabled_toast: "Eklenti devre dışı bırakıldı",
    search_placeholder: "Eklenti ara",
    filter_all: "Tüm kategoriler",
    filter_billing: "Faturalama",
    filter_compliance: "Uyumluluk",
    filter_productivity: "Verimlilik",
    filter_integrations: "Entegrasyonlar",
    filter_reporting: "Raporlama",
    status_all: "Tümü",
    status_enabled: "Etkin",
    status_disabled: "Devre dışı",
    status_planned: "Planlanan",
    view_grid: "Izgara",
    view_list: "Liste",
    chip_planned: "Planlanan",
    chip_cloud_only: "Yalnızca bulut",
    chip_requires_feature: "Plan gerekli",
    chip_requires_app_upgrade: "Inkvoice güncelleyin",
    update_badge: "Güncelleme var",
    installed_version: "Yüklü",
    latest_version: "Son sürüm",
    back: "Eklentilere dön",
    docs_link: "Belgeler",
    source_link: "Kaynak",
    vote_button: "Bunu istiyorum",
    votes_count: "{{count}} oy",
    update_banner: "Sürüm {{version}} hazır. Bunu almak için Inkvoice'u {{app}} veya daha yenisine yükseltin.",
    update_banner_simple: "Sürüm {{version}} hazır. Bunu almak için Inkvoice'u yükseltin.",
    view_release: "Sürüm notları",
    footer_synced: "Katalog senkronize edildi: {{age}}",
    footer_off: "Uzak katalog kapatıldı.",
    footer_failed: "Paket kataloğu kullanılıyor. Son senkronizasyon başarısız: {{reason}}",
    footer_refresh: "Yenile",
    footer_turn_off: "Kapat",
    time_just_now: "şimdi",
    time_minutes_ago: "{{count}} dk önce",
    time_hours_ago: "{{count}} sa önce",
    time_days_ago: "{{count}} g önce",
    detail_not_found: "Bu eklenti katalogda yok.",
    no_matches: "Arama ve filtrelerle eşleşen eklenti yok.",
    clear_filters: "Filtreleri temizle",
  },
});

registerTranslations("de", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Optionale Erweiterungen für Ihren Arbeitsbereich aktivieren oder deaktivieren.",
    empty: "Keine Plugins verfügbar.",
    enable: "Aktivieren",
    disable: "Deaktivieren",
    enabled_toast: "Plugin aktiviert",
    disabled_toast: "Plugin deaktiviert",
    search_placeholder: "Plugins durchsuchen",
    filter_all: "Alle Kategorien",
    filter_billing: "Fakturierung",
    filter_compliance: "Compliance",
    filter_productivity: "Produktivität",
    filter_integrations: "Integrationen",
    filter_reporting: "Berichte",
    status_all: "Alle",
    status_enabled: "Aktiv",
    status_disabled: "Inaktiv",
    status_planned: "Geplant",
    view_grid: "Raster",
    view_list: "Liste",
    chip_planned: "Geplant",
    chip_cloud_only: "Nur Cloud",
    chip_requires_feature: "Plan erforderlich",
    chip_requires_app_upgrade: "Inkvoice aktualisieren",
    update_badge: "Update verfügbar",
    installed_version: "Installiert",
    latest_version: "Neueste",
    back: "Zurück zu den Plugins",
    docs_link: "Dokumentation",
    source_link: "Quelle",
    vote_button: "Das möchte ich",
    votes_count: "{{count}} Stimmen",
    update_banner: "Version {{version}} ist verfügbar. Führen Sie ein Upgrade auf Inkvoice {{app}} oder neuer durch, um sie zu erhalten.",
    update_banner_simple: "Version {{version}} ist verfügbar. Führen Sie ein Upgrade von Inkvoice durch, um sie zu erhalten.",
    view_release: "Versionshinweise",
    footer_synced: "Katalog synchronisiert: {{age}}",
    footer_off: "Der Remote-Katalog ist deaktiviert.",
    footer_failed: "Mitgelieferter Katalog wird verwendet. Letzte Synchronisierung fehlgeschlagen: {{reason}}",
    footer_refresh: "Aktualisieren",
    footer_turn_off: "Deaktivieren",
    time_just_now: "gerade jetzt",
    time_minutes_ago: "vor {{count}} Min.",
    time_hours_ago: "vor {{count}} Std.",
    time_days_ago: "vor {{count}} Tg.",
    detail_not_found: "Dieses Plugin ist nicht im Katalog.",
    no_matches: "Keine Plugins entsprechen der aktuellen Suche und den Filtern.",
    clear_filters: "Filter zurücksetzen",
  },
});

registerTranslations("es", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Active o desactive extensiones opcionales para su espacio de trabajo.",
    empty: "No hay plugins disponibles.",
    enable: "Activar",
    disable: "Desactivar",
    enabled_toast: "Plugin activado",
    disabled_toast: "Plugin desactivado",
    search_placeholder: "Buscar plugins",
    filter_all: "Todas las categorías",
    filter_billing: "Facturación",
    filter_compliance: "Cumplimiento",
    filter_productivity: "Productividad",
    filter_integrations: "Integraciones",
    filter_reporting: "Informes",
    status_all: "Todas",
    status_enabled: "Activados",
    status_disabled: "Desactivados",
    status_planned: "Planificados",
    view_grid: "Cuadrícula",
    view_list: "Lista",
    chip_planned: "Planificado",
    chip_cloud_only: "Solo cloud",
    chip_requires_feature: "Requiere plan",
    chip_requires_app_upgrade: "Actualice Inkvoice",
    update_badge: "Actualización disponible",
    installed_version: "Instalado",
    latest_version: "Última",
    back: "Volver a los plugins",
    docs_link: "Documentación",
    source_link: "Código fuente",
    vote_button: "Lo quiero",
    votes_count: "{{count}} votos",
    update_banner: "La versión {{version}} está disponible. Actualice Inkvoice a {{app}} o superior para obtenerla.",
    update_banner_simple: "La versión {{version}} está disponible. Actualice Inkvoice para obtenerla.",
    view_release: "Notas de la versión",
    footer_synced: "Catálogo sincronizado {{age}}",
    footer_off: "El catálogo remoto está desactivado.",
    footer_failed: "Usando el catálogo incluido. La última sincronización falló: {{reason}}",
    footer_refresh: "Actualizar",
    footer_turn_off: "Desactivar",
    time_just_now: "justo ahora",
    time_minutes_ago: "hace {{count}} min",
    time_hours_ago: "hace {{count}} h",
    time_days_ago: "hace {{count}} d",
    detail_not_found: "Este plugin no está en el catálogo.",
    no_matches: "Ningún plugin coincide con la búsqueda y los filtros actuales.",
    clear_filters: "Borrar filtros",
  },
});

registerTranslations("fr", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Activez ou désactivez les extensions optionnelles de votre espace de travail.",
    empty: "Aucun plugin disponible.",
    enable: "Activer",
    disable: "Désactiver",
    enabled_toast: "Plugin activé",
    disabled_toast: "Plugin désactivé",
    search_placeholder: "Rechercher des plugins",
    filter_all: "Toutes les catégories",
    filter_billing: "Facturation",
    filter_compliance: "Conformité",
    filter_productivity: "Productivité",
    filter_integrations: "Intégrations",
    filter_reporting: "Rapports",
    status_all: "Tous",
    status_enabled: "Activés",
    status_disabled: "Désactivés",
    status_planned: "Planifiés",
    view_grid: "Grille",
    view_list: "Liste",
    chip_planned: "Planifié",
    chip_cloud_only: "Cloud uniquement",
    chip_requires_feature: "Plan requis",
    chip_requires_app_upgrade: "Mettre à jour Inkvoice",
    update_badge: "Mise à jour disponible",
    installed_version: "Installé",
    latest_version: "Dernière",
    back: "Retour aux plugins",
    docs_link: "Documentation",
    source_link: "Source",
    vote_button: "Je le veux",
    votes_count: "{{count}} votes",
    update_banner: "La version {{version}} est disponible. Mettez Inkvoice à jour vers {{app}} ou plus récent pour l'obtenir.",
    update_banner_simple: "La version {{version}} est disponible. Mettez Inkvoice à jour pour l'obtenir.",
    view_release: "Notes de version",
    footer_synced: "Catalogue synchronisé {{age}}",
    footer_off: "Le catalogue distant est désactivé.",
    footer_failed: "Catalogue intégré utilisé. Échec de la dernière synchronisation : {{reason}}",
    footer_refresh: "Actualiser",
    footer_turn_off: "Désactiver",
    time_just_now: "à l'instant",
    time_minutes_ago: "il y a {{count}} min",
    time_hours_ago: "il y a {{count}} h",
    time_days_ago: "il y a {{count}} j",
    detail_not_found: "Ce plugin n'est pas dans le catalogue.",
    no_matches: "Aucun plugin ne correspond à la recherche et aux filtres actuels.",
    clear_filters: "Réinitialiser les filtres",
  },
});
```

- [ ] **Step 4: Verify nothing references the old nav key**

Run: `grep -rn "nav.extensions" packages/frontend/src; test $? -eq 1 && echo clean`
Expected: `clean` (grep found nothing).

- [ ] **Step 5: Typecheck, lint, bootstrap test**

Run: `bun run typecheck && bun run lint && bun test packages/frontend/src/tests/plugins-bootstrap.test.ts`
Expected: clean, PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/plugins/registry.ts packages/frontend/src/plugins/i18n.ts packages/frontend/src/i18n/en.ts packages/frontend/src/i18n/tr.ts packages/frontend/src/i18n/es.ts packages/frontend/src/i18n/de.ts packages/frontend/src/i18n/fr.ts packages/frontend/src/nav-registry.ts packages/frontend/src/components/layout/Sidebar.tsx packages/frontend/src/plugins/time-tracker/index.tsx
git commit -m "feat: plugin settings slot, catalog i18n keys, sidebar plugins label"
```

---

### Task 4: Master view

**Files:**
- Modify: `packages/frontend/src/plugins/PluginsSettingsTab.tsx` (full rewrite)
- Create: `packages/frontend/src/plugins/PluginDetailView.tsx` (placeholder only; Task 5 replaces it)

**Interfaces:**
- Consumes: store shape from Task 2 (`entries`, `provenance`, `loaded`, `loading`, `setEnabled`, `refresh`, `turnOff`, `ensureFetched`); helpers from Task 1 (`filterPlugins`, `blockedChipKey`, `footerState`, `loadViewPreference`, `saveViewPreference`, `CATEGORIES`, `catalogIcon`, types); i18n keys from Task 3.
- Produces: `PluginsSettingsTab` dispatching on the route param (detail implemented in Task 6).

- [ ] **Step 1: Rewrite `packages/frontend/src/plugins/PluginsSettingsTab.tsx`**

Replace the file's content with:

```tsx
// Admin Plugins settings tab: master list of the merged catalog with search,
// category and status filters, a grid/list view toggle and the provenance
// footer. Renders the detail view instead when the route carries a pluginId
// (see PluginDetailView). Data comes from the plugins store; the enable
// switch writes through PUT /api/v1/plugins/:id as before.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LayoutGrid, List, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PluginDetailView } from "./PluginDetailView";
import { catalogIcon } from "./icon-map";
import {
  blockedChipKey,
  CATEGORIES,
  filterPlugins,
  footerState,
  loadViewPreference,
  saveViewPreference,
  type CatalogPluginEntry,
  type CatalogProvenance,
  type PluginsView,
  type StatusFilter,
} from "./catalog";
import { usePluginsStore } from "./use-plugins.store";

const STATUS_FILTERS: StatusFilter[] = ["all", "enabled", "disabled", "planned"];

function BlockedChip({ entry }: { entry: CatalogPluginEntry }) {
  const { t } = useTranslation();
  const key = blockedChipKey(entry.blockedReason);
  if (!key) return null;
  return <Badge variant="secondary">{t(key)}</Badge>;
}

function UpdateBadge({ entry }: { entry: CatalogPluginEntry }) {
  const { t } = useTranslation();
  if (!entry.updateAvailable) return null;
  return <Badge variant="secondary">{t("plugins.update_badge")}</Badge>;
}

function EnableSwitch({ entry }: { entry: CatalogPluginEntry }) {
  const { t } = useTranslation();
  const loaded = usePluginsStore((s) => s.loaded);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  if (entry.blockedReason !== null) return null;
  return (
    <Switch
      checked={entry.enabled}
      disabled={!loaded}
      aria-label={`${t(entry.enabled ? "plugins.disable" : "plugins.enable")}: ${entry.name}`}
      onCheckedChange={(next) => {
        setEnabled(entry.id, next)
          .then(() => toast.success(t(next ? "plugins.enabled_toast" : "plugins.disabled_toast")))
          .catch((e: Error) => toast.error(e.message));
      }}
    />
  );
}

function PluginCard({ entry, view }: { entry: CatalogPluginEntry; view: PluginsView }) {
  const Icon = catalogIcon(entry.icon);
  return (
    <div
      className={
        view === "grid"
          ? "flex flex-col gap-3 border rounded-lg p-4"
          : "flex items-center justify-between gap-3 border rounded-lg p-3"
      }
    >
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Link to={`/settings/plugins/${entry.id}`} className="text-sm font-medium hover:underline truncate">
              {entry.name}
            </Link>
            <BlockedChip entry={entry} />
            <UpdateBadge entry={entry} />
          </div>
          <div className="text-xs text-muted-foreground line-clamp-2">{entry.tagline}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {entry.installedVersion && (
          <span className="text-xs text-muted-foreground">v{entry.installedVersion}</span>
        )}
        <EnableSwitch entry={entry} />
      </div>
    </div>
  );
}

function SyncFooter({ provenance }: { provenance: CatalogProvenance }) {
  const { t } = useTranslation();
  const refresh = usePluginsStore((s) => s.refresh);
  const turnOff = usePluginsStore((s) => s.turnOff);
  const loading = usePluginsStore((s) => s.loading);
  const state = footerState(provenance, Date.now());
  const age = (minutes: number | null) => {
    if (minutes === null || minutes < 1) return t("plugins.time_just_now");
    if (minutes < 60) return t("plugins.time_minutes_ago", { count: minutes });
    if (minutes < 1440) return t("plugins.time_hours_ago", { count: Math.floor(minutes / 60) });
    return t("plugins.time_days_ago", { count: Math.floor(minutes / 1440) });
  };

  if (state.kind === "off") {
    return <p className="text-xs text-muted-foreground">{t("plugins.footer_off")}</p>;
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {state.kind === "synced" ? (
        <span>{t("plugins.footer_synced", { age: age(state.ageMinutes) })} · inkvoice.app</span>
      ) : (
        <span>{t("plugins.footer_failed", { reason: state.reason })}</span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={loading}
        onClick={() => void refresh({ force: true })}
      >
        <RotateCw className="h-3 w-3" />
        {t("plugins.footer_refresh")}
      </Button>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void turnOff()}>
        {t("plugins.footer_turn_off")}
      </Button>
    </div>
  );
}

function PluginsMasterView() {
  const { t } = useTranslation();
  const entries = usePluginsStore((s) => s.entries);
  const provenance = usePluginsStore((s) => s.provenance);
  const loaded = usePluginsStore((s) => s.loaded);
  const ensureFetched = usePluginsStore((s) => s.ensureFetched);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [view, setView] = useState<PluginsView>(() => loadViewPreference());

  useEffect(() => {
    ensureFetched();
  }, [ensureFetched]);

  const filtered = useMemo(
    () => filterPlugins(entries, { query, category, status }),
    [entries, query, category, status],
  );

  const changeView = (next: PluginsView) => {
    setView(next);
    saveViewPreference(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("plugins.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("plugins.search_placeholder")}
            className="h-8 w-56"
          />
          <Select value={category} onValueChange={(v) => v && setCategory(v)}>
            <SelectTrigger size="sm" className="gap-1.5 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("plugins.filter_all")}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`plugins.filter_${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s}
                variant={status === s ? "default" : "outline"}
                size="sm"
                className="h-8 px-3"
                onClick={() => setStatus(s)}
              >
                {t(`plugins.status_${s}`)}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={view === "grid" ? "default" : "outline"}
              size="sm"
              className="h-8 px-2"
              aria-label={t("plugins.view_grid")}
              onClick={() => changeView("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={view === "list" ? "default" : "outline"}
              size="sm"
              className="h-8 px-2"
              aria-label={t("plugins.view_list")}
              onClick={() => changeView("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {loaded && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("plugins.empty")}</p>
        )}
        {loaded && entries.length > 0 && filtered.length === 0 && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{t("plugins.no_matches")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setCategory("all");
                setStatus("all");
              }}
            >
              {t("plugins.clear_filters")}
            </Button>
          </div>
        )}

        <div className={view === "grid" ? "grid gap-3 md:grid-cols-2" : "space-y-2"}>
          {filtered.map((p) => (
            <PluginCard key={p.id} entry={p} view={view} />
          ))}
        </div>

        {provenance && <SyncFooter provenance={provenance} />}
      </CardContent>
    </Card>
  );
}

export function PluginsSettingsTab() {
  const { pluginId } = useParams<{ pluginId?: string }>();
  if (pluginId) return <PluginDetailView pluginId={pluginId} />;
  return <PluginsMasterView />;
}
```

- [ ] **Step 2: Create the Task 5 placeholder detail view**

`packages/frontend/src/plugins/PluginDetailView.tsx`:

```tsx
// Placeholder. Replaced by the full detail view in Task 5; exists only so
// this task's file compiles on its own.
export function PluginDetailView({ pluginId }: { pluginId: string }) {
  void pluginId;
  return null;
}
```

- [ ] **Step 3: Typecheck, lint, run the frontend tests**

Run: `bun run typecheck && bun run lint && bun test packages/frontend`
Expected: clean, PASS (including `plugins-bootstrap.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/plugins/PluginsSettingsTab.tsx packages/frontend/src/plugins/PluginDetailView.tsx
git commit -m "feat: plugins tab master view with search, filters, layouts and sync footer"
```

---

### Task 5: Detail view and routes

**Files:**
- Modify: `packages/frontend/src/plugins/PluginDetailView.tsx` (replaces the Task 4 placeholder)
- Modify: `packages/frontend/src/App.tsx` (add the detail route beside the template sub-routes)
- Modify: `packages/frontend/src/pages/Settings.tsx` (add `isPluginSubRoute` beside `isTemplateSubRoute`)

**Interfaces:**
- Consumes: store from Task 2 (`entries`, `provenance`, `loaded`, `ensureFetched`, `setEnabled`, `vote`); `canVote`, `blockedChipKey`, `RELEASES_URL`, `CatalogPluginEntry` from Task 1; `catalogIcon` from Task 1; `FrontendPlugin.settings` from Task 3; i18n keys from Task 3.
- Produces: the detail view at `/settings/plugins/:pluginId`.

- [ ] **Step 1: Write `packages/frontend/src/plugins/PluginDetailView.tsx`**

Replace the placeholder's content with:

```tsx
// Plugin detail view at /settings/plugins/:pluginId. Follows the
// /settings/templates/:id/edit sub-route pattern: the parent Settings page
// resolves to the plugins tab and this renders inside its TabsContent.
// Shows identity, version state, enablement or the blocked reason, the
// update banner, description, links, the plugin's own settings component,
// and for planned entries the demand vote. Planned entries render no switch
// and no settings; a vote that cannot be sent (egress off) is not offered.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, BookOpen, ExternalLink, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { blockedChipKey, canVote, RELEASES_URL, type CatalogPluginEntry } from "./catalog";
import { catalogIcon } from "./icon-map";
import { getPlugins } from "./registry";
import { usePluginsStore } from "./use-plugins.store";

export function PluginDetailView({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const entries = usePluginsStore((s) => s.entries);
  const provenance = usePluginsStore((s) => s.provenance);
  const loaded = usePluginsStore((s) => s.loaded);
  const ensureFetched = usePluginsStore((s) => s.ensureFetched);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const vote = usePluginsStore((s) => s.vote);
  const [voting, setVoting] = useState(false);

  useEffect(() => {
    ensureFetched();
  }, [ensureFetched]);

  if (!loaded) return null;

  const entry = entries.find((p) => p.id === pluginId);
  if (!entry) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground space-y-4">
          <Link to="/settings/plugins" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {t("plugins.back")}
          </Link>
          <p>{t("plugins.detail_not_found")}</p>
        </CardContent>
      </Card>
    );
  }

  const Icon = catalogIcon(entry.icon);
  const chipKey = blockedChipKey(entry.blockedReason);
  const settingsPlugin = getPlugins().find((p) => p.id === entry.id);
  const SettingsPanel = settingsPlugin?.settings;
  const showSettings = entry.installed && entry.blockedReason === null && Boolean(SettingsPanel);
  const egressEnabled = provenance?.egressEnabled ?? false;

  const toggle = async (next: boolean) => {
    try {
      await setEnabled(entry.id, next);
      toast.success(t(next ? "plugins.enabled_toast" : "plugins.disabled_toast"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const sendVote = async () => {
    setVoting(true);
    try {
      const count = await vote(entry.id);
      if (count !== null) toast.success(t("plugins.votes_count", { count }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setVoting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <Link to="/settings/plugins" className="inline-flex items-center gap-1 text-sm hover:underline">
          <ArrowLeft className="h-4 w-4" />
          {t("plugins.back")}
        </Link>
        <div className="flex items-start gap-3">
          <Icon className="h-8 w-8 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {entry.name}
              <Badge variant="outline">{t(`plugins.filter_${entry.category}`)}</Badge>
              {chipKey && <Badge variant="secondary">{t(chipKey)}</Badge>}
            </CardTitle>
            <p className="text-sm text-muted-foreground">{entry.tagline}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("plugins.installed_version")}: {entry.installedVersion ?? "-"}
              {" · "}
              {t("plugins.latest_version")}: {entry.latestVersion ?? "-"}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {entry.updateAvailable && (
          <div className="rounded-lg border p-3 text-sm space-y-1">
            <p>
              {entry.updateRequiresApp
                ? t("plugins.update_banner", {
                    version: entry.latestVersion ?? "",
                    app: entry.updateRequiresApp,
                  })
                : t("plugins.update_banner_simple", { version: entry.latestVersion ?? "" })}
            </p>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs underline"
            >
              {t("plugins.view_release")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        {entry.status !== "planned" && entry.blockedReason === null && (
          <div className="flex items-center justify-between border rounded-lg p-3">
            <span className="text-sm">
              {t(entry.enabled ? "plugins.disable" : "plugins.enable")}
            </span>
            <Switch
              checked={entry.enabled}
              disabled={!loaded}
              aria-label={`${t(entry.enabled ? "plugins.disable" : "plugins.enable")}: ${entry.name}`}
              onCheckedChange={(next) => void toggle(next)}
            />
          </div>
        )}

        {canVote(entry, egressEnabled) && (
          <div className="flex items-center justify-between border rounded-lg p-3">
            <span className="text-sm">{t("plugins.votes_count", { count: entry.votes })}</span>
            <Button size="sm" disabled={voting} onClick={() => void sendVote()}>
              <ThumbsUp className="h-4 w-4" />
              {t("plugins.vote_button")}
            </Button>
          </div>
        )}

        <p className="text-sm whitespace-pre-line">{entry.description}</p>

        {(entry.docs || entry.source) && (
          <div className="flex items-center gap-4 text-sm">
            {entry.docs && (
              <a
                href={entry.docs}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                <BookOpen className="h-4 w-4" />
                {t("plugins.docs_link")}
              </a>
            )}
            {entry.source && (
              <a
                href={entry.source}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="h-4 w-4" />
                {t("plugins.source_link")}
              </a>
            )}
          </div>
        )}

        {showSettings && SettingsPanel && (
          <>
            <Separator />
            <SettingsPanel />
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

Note on lint: the `sonner` toast success on vote reuses `plugins.votes_count`; no extra key exists or is needed.

- [ ] **Step 2: Add the route in `App.tsx`**

Directly after the `/settings/templates/:id/edit` route element, add:

```tsx
<Route
  path="/settings/plugins/:pluginId"
  element={
    <AdminRoute>
      <Settings />
    </AdminRoute>
  }
/>
```

- [ ] **Step 3: Resolve the tab in `Settings.tsx`**

Beside the existing `isTemplateSubRoute` (around line 82), add:

```tsx
// Detect /settings/plugins/:pluginId so the tab resolves to plugins.
const isPluginSubRoute = location.pathname.startsWith("/settings/plugins/");
```

Update the `tab` computation (lines 85-89) to:

```tsx
const tab: SettingsTab = isTemplateSubRoute
  ? "templates"
  : isPluginSubRoute
    ? "plugins"
    : isSettingsTab(tabParam, extraTabs)
      ? (tabParam as SettingsTab)
      : "general";
```

And add `isPluginSubRoute` to the redirect guard in the `useEffect` at line 122:

```tsx
if (tabParam && !isSettingsTab(tabParam, extraTabs) && !isTemplateSubRoute && !isPluginSubRoute) {
  navigate("/settings/general", { replace: true });
}
```

with `isPluginSubRoute` added to that effect's dependency array.

- [ ] **Step 4: Verify the whole chain**

Run: `bun run lint && bun run typecheck && bun test`
Expected: all clean. `plugins-bootstrap.test.ts` must still pass (the tab registration is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/plugins/PluginDetailView.tsx packages/frontend/src/App.tsx packages/frontend/src/pages/Settings.tsx
git commit -m "feat: plugin detail view, vote affordance and settings sub-route"
```

---

## Definition of done

- `bun run lint && bun run typecheck && bun test` all pass (the CI chain).
- The Plugins tab renders the merged catalog: search, category filter, status chips, grid/list toggle persisted to `inkvoice.plugins.view`, distinct empty states, and the provenance footer in all three states.
- `/settings/plugins/:pluginId` renders the detail view inside the plugins tab; `/settings/templates/*` behavior is unchanged.
- Enablement writes still go through `PUT /api/v1/plugins/:id`; the nav gate and PluginGuard semantics are unchanged (`plugins-bootstrap.test.ts` proves the registrations).
- The vote button renders only for planned entries while egress is on, posts through the proxy, and patches the count.
- The sidebar section label reads from `nav.plugins` in all five languages; no `nav.extensions` reference remains in this repo.
- No new runtime or dev dependencies; no `.test.tsx` files; frontend tests are logic-only and pass under bare `bun test`.

## Manual verification (after implementation)

With the backend running (the live catalog is published at pigontech.github.io/inkvoice-plugins):

1. Settings, Plugins tab: search narrows, filters compose, toggle persists across reloads.
2. Time Tracker card: no chips, switch on, no update badge.
3. Peppol card: "Cloud only" chip, no switch.
4. Accounts Payable (planned): "Planned" chip, vote button visible while egress is on; clicking it posts through the backend proxy (it will report a failure while inkvoice.app does not serve the vote endpoint yet, which is the designed degradation and shows as a toast, never a broken page).
5. Footer: with the default URL unreachable, "Using bundled catalog. Last sync failed: HTTP 404" plus Refresh; after a successful refresh it reports the sync age; after Turn off it reports the off state.
6. Detail view for each kind: installed (switch + settings slot), planned (vote only), blocked (reason, no switch).

## What this plan does NOT do

No dynamic plugin installation, no in-place updates, no per-plugin permissions, no localised catalog content. The sidebar label change is OSS-side only; overlay nav registrations send the old key until spec D. `GET /api/v1/plugins` keeps its shape and simply loses its last frontend caller.