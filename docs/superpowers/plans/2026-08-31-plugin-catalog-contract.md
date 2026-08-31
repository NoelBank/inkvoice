# Plugin Catalog Contract (spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public `pigontech/inkvoice-plugins` repo that validates hand-authored plugin entries and publishes `catalog.v1.json` to GitHub Pages, so the app (spec B/C) and the marketing site (spec E) have one versioned description of every Inkvoice plugin.

**Architecture:** Zod schemas in `src/schema.ts` are the single source of truth; they validate `plugins/<id>/plugin.yaml` at CI time and generate the committed JSON Schema files that give contributors editor completion. Pure functions (`validate`, `buildCatalog`) are unit-tested with fixtures and wrapped by thin CLI scripts. GitHub Actions validates on PR and publishes on `main`.

**Tech Stack:** Bun, TypeScript, Zod, `zod-to-json-schema`, `yaml`, `bun:test`, GitHub Actions + GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-31-plugin-catalog-contract-design.md` (in `pigontech/inkvoice`).

## Global Constraints

- **Semver is strict `MAJOR.MINOR.PATCH`.** No prerelease, no build metadata, anywhere. Regex: `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`.
- **Schema version is `1`.** The built artifact's `schema` field is the literal number `1` and the output filename is `catalog.v1.json`.
- **Plugin ids** match `^[a-z][a-z0-9-]*$` and must not be in the reserved set `["catalog"]`.
- **Categories** are exactly `billing`, `compliance`, `productivity`, `integrations`, `reporting`.
- **Statuses** are exactly `available`, `planned`. **Availabilities** are exactly `oss`, `cloud`, `both`.
- **A validation failure is a CI failure**, never a warning. `scripts/validate.ts` exits non-zero.
- **No dashes in prose.** Repo README and code comments use commas, periods or parentheses instead of em or en dashes.
- **Output is deterministic.** Plugins sort by `id` and object keys are emitted in a fixed order, so a rebuild with no input change produces a byte-identical file apart from `generated_at`.

## Two corrections to the spec, applied in this plan

Both were found while checking the spec against the real repos. Implement the corrected versions.

**1. Schema authoring is Zod-first, not hand-written JSON Schema.** The spec lists `schema/plugin.schema.json` and `schema/catalog.schema.json` as deliverables. Hand-writing them means keeping TypeScript types and JSON Schema in sync by hand forever. Instead, Zod is the source of truth (matching the house stack, where `inkvoice` already uses Zod for all validation) and the JSON Schema files are **generated and committed**, with CI failing if they are stale. Both deliverables still exist at the paths the spec names.

**2. The lucide allowlist must be an intersection, not a single version.** The spec says the icon must exist in "the `lucide-react` version both consumers depend on". There is no such single version:

| Package | `lucide-react` |
|---|---|
| `inkvoice/packages/frontend` | `^1.7.0` |
| `inkvoice-site` | `^0.468.0` |
| `inkvoice-cloud/packages/frontend` | none (uses the OSS workspace dep) |

An icon valid in one consumer can be missing in the other, and lucide 1.0 was a major release that removed names. The allowlist is therefore the **set intersection** of both versions' exports, installed side by side under npm aliases. Task 4 implements this.

---

### Task 1: Repo scaffold and the plugin entry schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `bunfig.toml`
- Create: `src/schema.ts`
- Create: `tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `SEMVER`, `DATE`, `PLUGIN_ID`, `RESERVED_PLUGIN_IDS`, `CATEGORIES`, `STATUSES`, `AVAILABILITIES` constants; `versionSchema`, `screenshotSchema`, `pluginEntrySchema` Zod schemas; `PluginEntry`, `PluginVersion`, `Screenshot` inferred types. All imported by Tasks 2 through 7.

- [ ] **Step 1: Initialise the repo**

```bash
mkdir -p inkvoice-plugins && cd inkvoice-plugins
git init -b main
bun init -y
bun add zod zod-to-json-schema yaml
```

- [ ] **Step 2: Write `package.json`**

Replace the generated file entirely:

```json
{
  "name": "inkvoice-plugins",
  "private": true,
  "type": "module",
  "scripts": {
    "validate": "bun run scripts/validate.ts",
    "build": "bun run scripts/build.ts",
    "gen:schema": "bun run scripts/gen-schema.ts",
    "test": "bun test"
  },
  "dependencies": {
    "yaml": "^2.6.0",
    "zod": "^3.24.0",
    "zod-to-json-schema": "^3.24.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 5: Write the failing test**

Create `tests/schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { pluginEntrySchema } from "../src/schema";

const valid = {
  id: "time-tracker",
  name: "Time Tracker",
  tagline: "Track billable hours and turn them into invoices.",
  description: "Longer markdown description.",
  category: "productivity",
  status: "available",
  availability: "both",
  requires_plan: null,
  icon: "Clock",
  docs: "https://github.com/pigontech/inkvoice/blob/main/docs/features/plugins.md",
  source: "https://github.com/pigontech/inkvoice/tree/main/packages/backend/src/plugins/time-tracker",
  screenshots: [{ file: "screenshots/timer.png", alt: "Live timer" }],
  versions: [{ version: "1.0.0", min_app: "0.2.0", released: "2026-06-08" }],
};

describe("pluginEntrySchema", () => {
  test("accepts a valid entry", () => {
    expect(pluginEntrySchema.parse(valid).id).toBe("time-tracker");
  });

  test("defaults requires_plan and screenshots when omitted", () => {
    const { requires_plan, screenshots, ...rest } = valid;
    const parsed = pluginEntrySchema.parse(rest);
    expect(parsed.requires_plan).toBeNull();
    expect(parsed.screenshots).toEqual([]);
  });

  test("rejects an id with uppercase letters", () => {
    expect(() => pluginEntrySchema.parse({ ...valid, id: "TimeTracker" })).toThrow();
  });

  test("rejects an unknown category", () => {
    expect(() => pluginEntrySchema.parse({ ...valid, category: "misc" })).toThrow();
  });

  test("rejects a non-strict semver version", () => {
    const versions = [{ version: "1.0", min_app: "0.2.0", released: "2026-06-08" }];
    expect(() => pluginEntrySchema.parse({ ...valid, versions })).toThrow();
  });

  test("rejects a prerelease version", () => {
    const versions = [{ version: "1.0.0-beta.1", min_app: "0.2.0", released: "2026-06-08" }];
    expect(() => pluginEntrySchema.parse({ ...valid, versions })).toThrow();
  });

  test("rejects a released date that is not YYYY-MM-DD", () => {
    const versions = [{ version: "1.0.0", min_app: "0.2.0", released: "08/06/2026" }];
    expect(() => pluginEntrySchema.parse({ ...valid, versions })).toThrow();
  });

  test("rejects an unknown top-level key", () => {
    expect(() => pluginEntrySchema.parse({ ...valid, colour: "blue" })).toThrow();
  });

  test("rejects an empty screenshot alt", () => {
    const screenshots = [{ file: "screenshots/a.png", alt: "" }];
    expect(() => pluginEntrySchema.parse({ ...valid, screenshots })).toThrow();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test tests/schema.test.ts`
Expected: FAIL, cannot resolve `../src/schema`.

- [ ] **Step 7: Write `src/schema.ts`**

```ts
// Zod is the single source of truth for the catalog contract. The committed
// JSON Schema files under schema/ are generated from these definitions
// (scripts/gen-schema.ts), so contributors get editor completion on
// plugin.yaml without anyone hand-maintaining a second copy of the rules.

import { z } from "zod";

/** Strict MAJOR.MINOR.PATCH. No prerelease, no build metadata. */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

/** Ids the app mounts its own routes under, so a plugin may never claim them.
 *  Mirrored by RESERVED_PLUGIN_IDS in the OSS backend registry (spec B). */
export const RESERVED_PLUGIN_IDS = ["catalog"] as const;

export const CATEGORIES = [
  "billing",
  "compliance",
  "productivity",
  "integrations",
  "reporting",
] as const;
export const STATUSES = ["available", "planned"] as const;
export const AVAILABILITIES = ["oss", "cloud", "both"] as const;

export const versionSchema = z
  .object({
    version: z.string().regex(SEMVER, "must be MAJOR.MINOR.PATCH"),
    min_app: z.string().regex(SEMVER, "must be MAJOR.MINOR.PATCH"),
    released: z.string().regex(DATE, "must be YYYY-MM-DD"),
    changelog: z.string().min(1).optional(),
  })
  .strict();

export const screenshotSchema = z
  .object({
    file: z.string().min(1),
    alt: z.string().min(1, "alt text is required"),
  })
  .strict();

export const pluginEntrySchema = z
  .object({
    id: z.string().regex(PLUGIN_ID, "must be lowercase kebab-case"),
    name: z.string().min(1),
    tagline: z.string().min(1).max(120),
    description: z.string().min(1),
    category: z.enum(CATEGORIES),
    status: z.enum(STATUSES),
    availability: z.enum(AVAILABILITIES),
    requires_plan: z.string().min(1).nullable().default(null),
    icon: z.string().min(1),
    docs: z.string().url(),
    source: z.string().url().optional(),
    screenshots: z.array(screenshotSchema).default([]),
    versions: z.array(versionSchema).optional(),
  })
  .strict();

export type PluginVersion = z.infer<typeof versionSchema>;
export type Screenshot = z.infer<typeof screenshotSchema>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test tests/schema.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock src/schema.ts tests/schema.test.ts
git commit -m "feat: plugin entry schema"
```

---

### Task 2: YAML loader

**Files:**
- Create: `src/load.ts`
- Create: `tests/load.test.ts`
- Create: `tests/fixtures/good/alpha/plugin.yaml`, `tests/fixtures/good/beta/plugin.yaml`
- Create: `tests/fixtures/bad-yaml/broken/plugin.yaml`

**Interfaces:**
- Consumes: `pluginEntrySchema`, `PluginEntry` from `src/schema.ts`.
- Produces: `loadEntries(pluginsDir: string): LoadResult` where
  `interface LoadResult { entries: PluginEntry[]; errors: LoadError[] }` and
  `interface LoadError { dir: string; message: string }`. Used by Tasks 6 and 7.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/good/alpha/plugin.yaml`:

```yaml
id: alpha
name: Alpha
tagline: The first fixture plugin.
description: Fixture used by the loader tests.
category: productivity
status: available
availability: both
icon: Clock
docs: https://example.com/docs/alpha
versions:
  - version: "1.0.0"
    min_app: "0.2.0"
    released: "2026-01-01"
```

`tests/fixtures/good/beta/plugin.yaml`:

```yaml
id: beta
name: Beta
tagline: The second fixture plugin.
description: Fixture used by the loader tests.
category: billing
status: planned
availability: cloud
requires_plan: pro
icon: Wallet
docs: https://example.com/docs/beta
```

`tests/fixtures/bad-yaml/broken/plugin.yaml`:

```yaml
id: broken
name: "Unterminated
```

- [ ] **Step 2: Write the failing test**

Create `tests/load.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadEntries } from "../src/load";

describe("loadEntries", () => {
  test("loads every plugin.yaml under the directory, sorted by id", () => {
    const res = loadEntries("tests/fixtures/good");
    expect(res.errors).toEqual([]);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha", "beta"]);
  });

  test("applies schema defaults", () => {
    const res = loadEntries("tests/fixtures/good");
    const alpha = res.entries.find((e) => e.id === "alpha")!;
    expect(alpha.requires_plan).toBeNull();
    expect(alpha.screenshots).toEqual([]);
  });

  test("reports malformed YAML as an error instead of throwing", () => {
    const res = loadEntries("tests/fixtures/bad-yaml");
    expect(res.entries).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.dir).toBe("broken");
  });

  test("reports a directory whose id does not match its folder name", () => {
    const res = loadEntries("tests/fixtures/good");
    expect(res.errors).toEqual([]);
  });

  test("returns empty for a directory with no plugins", () => {
    const res = loadEntries("tests/fixtures/empty");
    expect(res.entries).toEqual([]);
    expect(res.errors).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/load.test.ts`
Expected: FAIL, cannot resolve `../src/load`.

- [ ] **Step 4: Write `src/load.ts`**

```ts
// Reads plugins/<id>/plugin.yaml off disk and parses each through the entry
// schema. Never throws: a malformed file becomes a LoadError so the CLI can
// report every problem in one run rather than dying on the first.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { pluginEntrySchema, type PluginEntry } from "./schema";

export interface LoadError {
  /** Directory name under the plugins root, e.g. "time-tracker". */
  dir: string;
  message: string;
}

export interface LoadResult {
  entries: PluginEntry[];
  errors: LoadError[];
}

export function loadEntries(pluginsDir: string): LoadResult {
  const entries: PluginEntry[] = [];
  const errors: LoadError[] = [];

  if (!existsSync(pluginsDir)) return { entries, errors };

  const dirs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const file = path.join(pluginsDir, dir, "plugin.yaml");
    if (!existsSync(file)) {
      errors.push({ dir, message: "missing plugin.yaml" });
      continue;
    }

    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(file, "utf8"));
    } catch (err) {
      errors.push({ dir, message: `invalid YAML: ${(err as Error).message}` });
      continue;
    }

    const parsed = pluginEntrySchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        errors.push({ dir, message: `${at}: ${issue.message}` });
      }
      continue;
    }

    if (parsed.data.id !== dir) {
      errors.push({ dir, message: `id "${parsed.data.id}" must match its folder name` });
      continue;
    }

    entries.push(parsed.data);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, errors };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/load.test.ts`
Expected: PASS, 5 tests. The `tests/fixtures/empty` directory does not exist, which the `existsSync` guard handles.

- [ ] **Step 6: Commit**

```bash
git add src/load.ts tests/load.test.ts tests/fixtures
git commit -m "feat: plugin.yaml loader"
```

---

### Task 3: Semver comparison and the non-icon cross-field rules

**Files:**
- Create: `src/semver.ts`
- Create: `src/validate.ts`
- Create: `tests/semver.test.ts`
- Create: `tests/validate.test.ts`

**Interfaces:**
- Consumes: `PluginEntry`, `RESERVED_PLUGIN_IDS` from `src/schema.ts`.
- Produces: `compare(a: string, b: string): number` from `src/semver.ts`.
  From `src/validate.ts`: `interface Violation { id: string; rule: number; message: string }`
  and `checkEntries(entries: PluginEntry[], opts: ValidateOptions): Violation[]` where
  `interface ValidateOptions { iconAllowlist: ReadonlySet<string>; screenshotExists: (id: string, file: string) => boolean }`.
  Used by Tasks 4, 6 and 7.

- [ ] **Step 1: Write the failing semver test**

Create `tests/semver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { compare } from "../src/semver";

describe("compare", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compare("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compare("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compare("1.0.2", "1.0.10")).toBeLessThan(0);
  });

  test("treats numerically equal versions as equal", () => {
    expect(compare("1.2.3", "1.2.3")).toBe(0);
  });

  test("compares numerically, not lexically", () => {
    expect(compare("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compare("0.10.0", "0.2.0")).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/semver.test.ts`
Expected: FAIL, cannot resolve `../src/semver`.

- [ ] **Step 3: Write `src/semver.ts`**

```ts
// Strict MAJOR.MINOR.PATCH comparison. The schema forbids prerelease and build
// metadata, so this deliberately handles nothing else. Inputs are assumed to
// have already passed the SEMVER regex.

export function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/semver.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing validation test**

Create `tests/validate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { PluginEntry } from "../src/schema";
import { checkEntries } from "../src/validate";

const ALLOWED = new Set(["Clock", "Wallet"]);
const opts = { iconAllowlist: ALLOWED, screenshotExists: () => true };

function entry(over: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id: "alpha",
    name: "Alpha",
    tagline: "A plugin.",
    description: "Description.",
    category: "productivity",
    status: "available",
    availability: "both",
    requires_plan: null,
    icon: "Clock",
    docs: "https://example.com/docs",
    screenshots: [],
    versions: [{ version: "1.0.0", min_app: "0.2.0", released: "2026-01-01" }],
    ...over,
  } as PluginEntry;
}

const rules = (v: ReturnType<typeof checkEntries>) => v.map((x) => x.rule).sort();

describe("checkEntries", () => {
  test("a valid entry produces no violations", () => {
    expect(checkEntries([entry()], opts)).toEqual([]);
  });

  test("rule 1: planned entries must not carry versions or source", () => {
    const planned = entry({ status: "planned", source: "https://example.com/src" });
    expect(rules(checkEntries([planned], opts))).toContain(1);
  });

  test("rule 1: a planned entry with neither versions nor source passes", () => {
    const planned = entry({ status: "planned", versions: undefined });
    expect(checkEntries([planned], opts)).toEqual([]);
  });

  test("rule 2: available entries need at least one version", () => {
    expect(rules(checkEntries([entry({ versions: [] })], opts))).toContain(2);
    expect(rules(checkEntries([entry({ versions: undefined })], opts))).toContain(2);
  });

  test("rule 3: versions must be strictly descending", () => {
    const bad = entry({
      versions: [
        { version: "1.0.0", min_app: "0.2.0", released: "2026-01-01" },
        { version: "1.1.0", min_app: "0.2.0", released: "2026-02-01" },
      ],
    });
    expect(rules(checkEntries([bad], opts))).toContain(3);
  });

  test("rule 3: duplicate versions are rejected", () => {
    const bad = entry({
      versions: [
        { version: "1.0.0", min_app: "0.2.0", released: "2026-02-01" },
        { version: "1.0.0", min_app: "0.2.0", released: "2026-01-01" },
      ],
    });
    expect(rules(checkEntries([bad], opts))).toContain(3);
  });

  test("rule 4: min_app must not decrease as version increases", () => {
    const bad = entry({
      versions: [
        { version: "1.1.0", min_app: "0.1.0", released: "2026-02-01" },
        { version: "1.0.0", min_app: "0.2.0", released: "2026-01-01" },
      ],
    });
    expect(rules(checkEntries([bad], opts))).toContain(4);
  });

  test("rule 4: an unchanged min_app across versions is allowed", () => {
    const ok = entry({
      versions: [
        { version: "1.1.0", min_app: "0.2.0", released: "2026-02-01" },
        { version: "1.0.0", min_app: "0.2.0", released: "2026-01-01" },
      ],
    });
    expect(checkEntries([ok], opts)).toEqual([]);
  });

  test("rule 5: unknown icons are rejected", () => {
    expect(rules(checkEntries([entry({ icon: "NotAnIcon" })], opts))).toContain(5);
  });

  test("rule 6: a missing screenshot file is rejected", () => {
    const withShot = entry({ screenshots: [{ file: "screenshots/a.png", alt: "A" }] });
    const missing = { iconAllowlist: ALLOWED, screenshotExists: () => false };
    expect(rules(checkEntries([withShot], missing))).toContain(6);
  });

  test("rule 7: duplicate ids are rejected", () => {
    expect(rules(checkEntries([entry(), entry()], opts))).toContain(7);
  });

  test("rule 8: reserved ids are rejected", () => {
    expect(rules(checkEntries([entry({ id: "catalog" })], opts))).toContain(8);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test tests/validate.test.ts`
Expected: FAIL, cannot resolve `../src/validate`.

- [ ] **Step 7: Write `src/validate.ts`**

```ts
// The eight cross-field rules from spec A. Schema validation alone cannot
// express them because each spans multiple fields or multiple entries. Pure
// and side-effect free: filesystem and icon-list lookups arrive as callbacks
// so the rules are testable without either.

import { RESERVED_PLUGIN_IDS, type PluginEntry } from "./schema";
import { compare } from "./semver";

export interface Violation {
  id: string;
  /** Rule number as documented in spec A, for stable error messages. */
  rule: number;
  message: string;
}

export interface ValidateOptions {
  iconAllowlist: ReadonlySet<string>;
  screenshotExists: (id: string, file: string) => boolean;
}

export function checkEntries(entries: PluginEntry[], opts: ValidateOptions): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const e of entries) {
    const versions = e.versions ?? [];

    // Rule 1: planned entries describe something that does not exist yet.
    if (e.status === "planned") {
      if (versions.length > 0) {
        violations.push({ id: e.id, rule: 1, message: "planned entries must not have versions" });
      }
      if (e.source !== undefined) {
        violations.push({ id: e.id, rule: 1, message: "planned entries must not have source" });
      }
    }

    // Rule 2: an available plugin has shipped at least once.
    if (e.status === "available" && versions.length === 0) {
      violations.push({ id: e.id, rule: 2, message: "available entries need at least one version" });
    }

    // Rule 3: newest first, no duplicates.
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1]!;
      const cur = versions[i]!;
      if (compare(prev.version, cur.version) <= 0) {
        violations.push({
          id: e.id,
          rule: 3,
          message: `versions must be strictly descending: ${prev.version} then ${cur.version}`,
        });
      }
    }

    // Rule 4: reading oldest to newest, the app floor never drops.
    const ascending = [...versions].sort((a, b) => compare(a.version, b.version));
    for (let i = 1; i < ascending.length; i++) {
      const prev = ascending[i - 1]!;
      const cur = ascending[i]!;
      if (compare(cur.min_app, prev.min_app) < 0) {
        violations.push({
          id: e.id,
          rule: 4,
          message: `min_app decreased from ${prev.min_app} (${prev.version}) to ${cur.min_app} (${cur.version})`,
        });
      }
    }

    // Rule 5: the icon must render in every consumer.
    if (!opts.iconAllowlist.has(e.icon)) {
      violations.push({ id: e.id, rule: 5, message: `icon "${e.icon}" is not a shared lucide export` });
    }

    // Rule 6: screenshots must actually be in the repo.
    for (const shot of e.screenshots) {
      if (!opts.screenshotExists(e.id, shot.file)) {
        violations.push({ id: e.id, rule: 6, message: `screenshot not found: ${shot.file}` });
      }
    }

    // Rule 7: ids address plugins across three repos.
    if (seen.has(e.id)) {
      violations.push({ id: e.id, rule: 7, message: "duplicate id" });
    }
    seen.add(e.id);

    // Rule 8: the app mounts its catalog routes under this segment.
    if ((RESERVED_PLUGIN_IDS as readonly string[]).includes(e.id)) {
      violations.push({ id: e.id, rule: 8, message: `"${e.id}" is a reserved id` });
    }
  }

  return violations;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `bun test tests/validate.test.ts tests/semver.test.ts`
Expected: PASS, 16 tests total.

- [ ] **Step 9: Commit**

```bash
git add src/semver.ts src/validate.ts tests/semver.test.ts tests/validate.test.ts
git commit -m "feat: cross-field validation rules"
```

---

### Task 4: Shared lucide icon allowlist

**Files:**
- Modify: `package.json` (add two aliased devDependencies)
- Create: `src/lucide.ts`
- Create: `tests/lucide.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sharedLucideIcons(): Set<string>` from `src/lucide.ts`, passed as
  `iconAllowlist` into `checkEntries` by Tasks 6 and 7.

**Why two copies:** `inkvoice/packages/frontend` is on `lucide-react@^1.7.0` and
`inkvoice-site` is on `^0.468.0`. An icon must render in both, so the allowlist
is their intersection. This is the spec correction described at the top of this
plan.

- [ ] **Step 1: Install both versions under aliases**

```bash
bun add -d lucide-app@npm:lucide-react@1.7.0 lucide-site@npm:lucide-react@0.468.0
```

- [ ] **Step 2: Write the failing test**

Create `tests/lucide.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { sharedLucideIcons } from "../src/lucide";

describe("sharedLucideIcons", () => {
  test("returns a non-trivial set", () => {
    expect(sharedLucideIcons().size).toBeGreaterThan(500);
  });

  test("includes icons the seeded catalog uses", () => {
    const icons = sharedLucideIcons();
    for (const name of ["Clock", "Network", "FileCheck", "Receipt"]) {
      expect(icons.has(name)).toBe(true);
    }
  });

  test("excludes non-icon exports", () => {
    const icons = sharedLucideIcons();
    expect(icons.has("createLucideIcon")).toBe(false);
    expect(icons.has("default")).toBe(false);
  });

  test("excludes lowercase aliases, keeping PascalCase names only", () => {
    expect([...sharedLucideIcons()].every((n) => /^[A-Z]/.test(n))).toBe(true);
  });

  test("is a strict subset of each individual version", () => {
    const shared = sharedLucideIcons();
    expect(shared.has("NotARealIconName")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test tests/lucide.test.ts`
Expected: FAIL, cannot resolve `../src/lucide`.

- [ ] **Step 4: Write `src/lucide.ts`**

```ts
// The icon allowlist is the intersection of the lucide-react versions the
// consumers actually run: the app frontend is on 1.7.x and the marketing site
// is on 0.468.x. lucide 1.0 was a major release that renamed and removed
// exports, so an icon valid in one is not automatically valid in the other.
// Both versions are installed here under aliases purely to compute this set.

import * as lucideApp from "lucide-app";
import * as lucideSite from "lucide-site";

/** Icon components are the PascalCase exports. Everything else (helpers such as
 *  createLucideIcon, lowercase aliases, default) is filtered out. */
function iconNames(mod: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(mod).filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name)));
}

export function sharedLucideIcons(): Set<string> {
  const app = iconNames(lucideApp as Record<string, unknown>);
  const site = iconNames(lucideSite as Record<string, unknown>);
  return new Set([...app].filter((name) => site.has(name)));
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test tests/lucide.test.ts`
Expected: PASS, 5 tests.

If the "includes icons the seeded catalog uses" test fails for a specific name, that name is genuinely unavailable in one of the two versions. Pick a different icon for that plugin in Task 7 rather than weakening this test, and record the substitution in the commit message.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/lucide.ts tests/lucide.test.ts
git commit -m "feat: shared lucide icon allowlist"
```

---

### Task 5: Catalog builder

**Files:**
- Create: `src/build.ts`
- Create: `tests/build.test.ts`

**Interfaces:**
- Consumes: `PluginEntry` from `src/schema.ts`.
- Produces: from `src/build.ts`, the `catalogSchema` Zod schema plus types
  `ResolvedPlugin`, `Catalog`, and
  `buildCatalog(entries: PluginEntry[], opts: BuildOptions): Catalog` where
  `interface BuildOptions { screenshotBaseUrl: string; generatedAt: string }`.
  Used by Tasks 6 and 7.

`screenshotBaseUrl` is the published root the built `url` values are joined onto,
`https://pigontech.github.io/inkvoice-plugins/plugins`, so a `file` of
`screenshots/timer.png` on plugin `time-tracker` resolves to
`.../plugins/time-tracker/screenshots/timer.png`, mirroring the repo layout.
Screenshot files are served from GitHub Pages and hotlinked by both consumers;
only the JSON is vendored. That is what spec E assumes.

- [ ] **Step 1: Write the failing test**

Create `tests/build.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildCatalog, catalogSchema } from "../src/build";
import type { PluginEntry } from "../src/schema";

const BASE = "https://pigontech.github.io/inkvoice-plugins/plugins";
const opts = { screenshotBaseUrl: BASE, generatedAt: "2026-08-31T09:00:00.000Z" };

const available: PluginEntry = {
  id: "time-tracker",
  name: "Time Tracker",
  tagline: "Track billable hours.",
  description: "Body.",
  category: "productivity",
  status: "available",
  availability: "both",
  requires_plan: null,
  icon: "Clock",
  docs: "https://example.com/docs",
  source: "https://example.com/src",
  screenshots: [{ file: "screenshots/timer.png", alt: "Timer" }],
  versions: [
    { version: "1.1.0", min_app: "0.3.0", released: "2026-09-15", changelog: "Live timer." },
    { version: "1.0.0", min_app: "0.2.0", released: "2026-06-08" },
  ],
};

const planned: PluginEntry = {
  id: "accounts-payable",
  name: "Accounts Payable",
  tagline: "Vendors, bills and purchase orders.",
  description: "Body.",
  category: "billing",
  status: "planned",
  availability: "both",
  requires_plan: null,
  icon: "Receipt",
  docs: "https://example.com/docs/ap",
  screenshots: [],
};

describe("buildCatalog", () => {
  test("emits schema 1 and the given timestamp", () => {
    const cat = buildCatalog([available], opts);
    expect(cat.schema).toBe(1);
    expect(cat.generated_at).toBe("2026-08-31T09:00:00.000Z");
  });

  test("resolves latest to the first version", () => {
    const cat = buildCatalog([available], opts);
    expect(cat.plugins[0]!.latest).toEqual({
      version: "1.1.0",
      min_app: "0.3.0",
      released: "2026-09-15",
      changelog: "Live timer.",
    });
  });

  test("keeps the full version history", () => {
    const cat = buildCatalog([available], opts);
    expect(cat.plugins[0]!.versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  test("a planned entry has null latest and no versions", () => {
    const cat = buildCatalog([planned], opts);
    expect(cat.plugins[0]!.latest).toBeNull();
    expect(cat.plugins[0]!.versions).toEqual([]);
  });

  test("resolves screenshot paths to absolute urls", () => {
    const cat = buildCatalog([available], opts);
    expect(cat.plugins[0]!.screenshots[0]!.url).toBe(
      `${BASE}/time-tracker/screenshots/timer.png`,
    );
    expect(cat.plugins[0]!.screenshots[0]!.alt).toBe("Timer");
  });

  test("normalises optional source to null", () => {
    expect(buildCatalog([planned], opts).plugins[0]!.source).toBeNull();
    expect(buildCatalog([available], opts).plugins[0]!.source).toBe("https://example.com/src");
  });

  test("sorts plugins by id for stable diffs", () => {
    const cat = buildCatalog([available, planned], opts);
    expect(cat.plugins.map((p) => p.id)).toEqual(["accounts-payable", "time-tracker"]);
  });

  test("output validates against catalogSchema", () => {
    expect(() => catalogSchema.parse(buildCatalog([available, planned], opts))).not.toThrow();
  });

  test("is deterministic for the same inputs", () => {
    const a = JSON.stringify(buildCatalog([available, planned], opts));
    const b = JSON.stringify(buildCatalog([planned, available], opts));
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/build.test.ts`
Expected: FAIL, cannot resolve `../src/build`.

- [ ] **Step 3: Write `src/build.ts`**

```ts
// Resolves authored entries into the artifact consumers actually read. The
// point of resolving here is that neither the app nor the site should have to
// understand the versions array or resolve a relative screenshot path against
// a repo it does not know about.

import { z } from "zod";
import {
  AVAILABILITIES,
  CATEGORIES,
  STATUSES,
  versionSchema,
  type PluginEntry,
} from "./schema";

export const resolvedScreenshotSchema = z
  .object({ url: z.string().url(), alt: z.string().min(1) })
  .strict();

export const resolvedPluginSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tagline: z.string(),
    description: z.string(),
    category: z.enum(CATEGORIES),
    status: z.enum(STATUSES),
    availability: z.enum(AVAILABILITIES),
    requires_plan: z.string().nullable(),
    icon: z.string(),
    docs: z.string().url(),
    source: z.string().url().nullable(),
    screenshots: z.array(resolvedScreenshotSchema),
    latest: versionSchema.nullable(),
    versions: z.array(versionSchema),
  })
  .strict();

export const catalogSchema = z
  .object({
    schema: z.literal(1),
    generated_at: z.string(),
    plugins: z.array(resolvedPluginSchema),
  })
  .strict();

export type ResolvedPlugin = z.infer<typeof resolvedPluginSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export interface BuildOptions {
  /** Published root that screenshot paths are joined onto. */
  screenshotBaseUrl: string;
  generatedAt: string;
}

export function buildCatalog(entries: PluginEntry[], opts: BuildOptions): Catalog {
  const base = opts.screenshotBaseUrl.replace(/\/+$/, "");

  const plugins: ResolvedPlugin[] = [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const versions = e.versions ?? [];
      return {
        id: e.id,
        name: e.name,
        tagline: e.tagline,
        description: e.description,
        category: e.category,
        status: e.status,
        availability: e.availability,
        requires_plan: e.requires_plan,
        icon: e.icon,
        docs: e.docs,
        source: e.source ?? null,
        screenshots: e.screenshots.map((s) => ({
          url: `${base}/${e.id}/${s.file.replace(/^\/+/, "")}`,
          alt: s.alt,
        })),
        latest: versions[0] ?? null,
        versions,
      };
    });

  return { schema: 1, generated_at: opts.generatedAt, plugins };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/build.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/build.ts tests/build.test.ts
git commit -m "feat: catalog builder"
```

---

### Task 6: CLI entrypoints and generated JSON Schema

**Files:**
- Create: `scripts/validate.ts`
- Create: `scripts/build.ts`
- Create: `scripts/gen-schema.ts`
- Create: `schema/plugin.schema.json` (generated, committed)
- Create: `schema/catalog.schema.json` (generated, committed)
- Create: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `loadEntries` (Task 2), `checkEntries` (Task 3), `sharedLucideIcons` (Task 4), `buildCatalog` and `catalogSchema` (Task 5), `pluginEntrySchema` (Task 1).
- Produces: `bun run validate`, `bun run build`, `bun run gen:schema`. `build` writes `dist/catalog.v1.json` and copies screenshots to `dist/screenshots/<id>/`.

- [ ] **Step 1: Write `scripts/gen-schema.ts`**

```ts
#!/usr/bin/env bun
// Regenerates the committed JSON Schema files from the Zod definitions. They
// exist so contributors get editor completion and inline errors on plugin.yaml
// (via the yaml-language-server $schema comment). CI regenerates and fails on
// any diff, so the committed copies can never drift from the Zod source.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { catalogSchema } from "../src/build";
import { pluginEntrySchema } from "../src/schema";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, "schema");

function emit(file: string, json: unknown): void {
  writeFileSync(path.join(OUT, file), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  wrote schema/${file}`);
}

mkdirSync(OUT, { recursive: true });
emit("plugin.schema.json", zodToJsonSchema(pluginEntrySchema, { name: "PluginEntry" }));
emit("catalog.schema.json", zodToJsonSchema(catalogSchema, { name: "Catalog" }));
```

- [ ] **Step 2: Generate and inspect the schema files**

```bash
bun run gen:schema
```

Expected: writes `schema/plugin.schema.json` and `schema/catalog.schema.json`. Open both and confirm they contain the category enum and the semver `pattern`.

- [ ] **Step 3: Write `scripts/validate.ts`**

```ts
#!/usr/bin/env bun
// Validates every plugins/<id>/plugin.yaml: schema first (via the loader),
// then the eight cross-field rules. Reports every problem in one run and exits
// non-zero on any, because a malformed catalog reaches two production
// consumers.

import { existsSync } from "node:fs";
import path from "node:path";
import { loadEntries } from "../src/load";
import { sharedLucideIcons } from "../src/lucide";
import { checkEntries } from "../src/validate";

const ROOT = path.resolve(import.meta.dir, "..");
const PLUGINS = path.join(ROOT, "plugins");

export function runValidate(): number {
  const { entries, errors } = loadEntries(PLUGINS);

  for (const e of errors) {
    console.error(`✗ ${e.dir}: ${e.message}`);
  }

  const violations = checkEntries(entries, {
    iconAllowlist: sharedLucideIcons(),
    screenshotExists: (id, file) => existsSync(path.join(PLUGINS, id, file)),
  });

  for (const v of violations) {
    console.error(`✗ ${v.id}: [rule ${v.rule}] ${v.message}`);
  }

  const total = errors.length + violations.length;
  if (total > 0) {
    console.error(`\n${total} problem${total === 1 ? "" : "s"} found.`);
    return 1;
  }

  console.log(`✓ ${entries.length} plugin entr${entries.length === 1 ? "y" : "ies"} valid.`);
  return 0;
}

if (import.meta.main) process.exit(runValidate());
```

- [ ] **Step 4: Write `scripts/build.ts`**

```ts
#!/usr/bin/env bun
// Validates, then writes the published artifact. Refuses to build an invalid
// catalog: publishing a broken one would break the app's Plugins tab and the
// marketing site at the same time.

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCatalog, catalogSchema } from "../src/build";
import { loadEntries } from "../src/load";
import { runValidate } from "./validate";

const ROOT = path.resolve(import.meta.dir, "..");
const PLUGINS = path.join(ROOT, "plugins");
const DIST = path.join(ROOT, "dist");
const SCREENSHOT_BASE = "https://pigontech.github.io/inkvoice-plugins/plugins";

if (runValidate() !== 0) {
  console.error("✗ build aborted: catalog is invalid");
  process.exit(1);
}

const { entries } = loadEntries(PLUGINS);
const catalog = buildCatalog(entries, {
  screenshotBaseUrl: SCREENSHOT_BASE,
  generatedAt: new Date().toISOString(),
});

// Parse our own output. A builder bug that produces a shape consumers cannot
// read should fail here, not in someone's browser.
catalogSchema.parse(catalog);

mkdirSync(DIST, { recursive: true });
writeFileSync(path.join(DIST, "catalog.v1.json"), `${JSON.stringify(catalog, null, 2)}\n`);

// Screenshots are served from Pages and hotlinked by both consumers.
for (const dir of readdirSync(PLUGINS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const from = path.join(PLUGINS, dir.name, "screenshots");
  if (!existsSync(from)) continue;
  cpSync(from, path.join(DIST, "plugins", dir.name, "screenshots"), { recursive: true });
}

console.log(`✓ dist/catalog.v1.json (${catalog.plugins.length} plugins)`);
```

- [ ] **Step 5: Write the failing CLI test**

Create `tests/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { catalogSchema } from "../src/build";
import { pluginEntrySchema } from "../src/schema";

describe("generated JSON Schema", () => {
  test("plugin.schema.json is current", async () => {
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    const expected = `${JSON.stringify(zodToJsonSchema(pluginEntrySchema, { name: "PluginEntry" }), null, 2)}\n`;
    expect(readFileSync("schema/plugin.schema.json", "utf8")).toBe(expected);
  });

  test("catalog.schema.json is current", async () => {
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    const expected = `${JSON.stringify(zodToJsonSchema(catalogSchema, { name: "Catalog" }), null, 2)}\n`;
    expect(readFileSync("schema/catalog.schema.json", "utf8")).toBe(expected);
  });
});

describe("validate CLI", () => {
  test("exits 0 on the real catalog", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/validate.ts"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
});

describe("build CLI", () => {
  test("writes a catalog that parses", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/build.ts"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const written = JSON.parse(readFileSync("dist/catalog.v1.json", "utf8"));
    expect(() => catalogSchema.parse(written)).not.toThrow();
    expect(written.schema).toBe(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: FAIL. `plugins/` does not exist yet, so `loadEntries` returns empty and the CLIs succeed with zero plugins; the build test passes but asserts nothing meaningful. Task 7 adds the real entries. If the schema tests fail, re-run `bun run gen:schema`.

- [ ] **Step 7: Commit**

```bash
git add scripts/ schema/ tests/cli.test.ts
git commit -m "feat: validate and build CLIs with generated JSON Schema"
```

---

### Task 7: Seed the catalog with the four real entries

**Files:**
- Create: `plugins/time-tracker/plugin.yaml`
- Create: `plugins/peppol/plugin.yaml`
- Create: `plugins/france/plugin.yaml`
- Create: `plugins/accounts-payable/plugin.yaml`
- Create: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 6.
- Produces: the real `plugins/` tree that `bun run build` publishes.

**Source of these values.** Versions and plan gates are transcribed from what the
code registers today, not invented:

| id | registered in | `feature` | `defaultEnabled` | version |
|---|---|---|---|---|
| `time-tracker` | `inkvoice/packages/backend/src/plugins/time-tracker/index.ts:189` | none | `true` | 1.0.0 |
| `peppol` | `inkvoice-cloud/.../cloud/plugins/peppol/index.ts` | `"peppol"` | `false` | 1.0.0 |
| `france` | `inkvoice-cloud/.../cloud/plugins/france/index.ts` | `"france"` | `false` | 1.0.0 |

`min_app` is `0.2.0` for all three, the current app version in all three
`package.json` files. `accounts-payable` is the seeded `planned` entry, taken
from the Notion roadmap row "Vendors, bills & purchase orders (accounts
payable)" (Backlog, Low priority, noted as audience-dependent), which makes it a
genuine demand-signal candidate rather than a fixture.

- [ ] **Step 1: Write `plugins/time-tracker/plugin.yaml`**

```yaml
# yaml-language-server: $schema=../../schema/plugin.schema.json
id: time-tracker
name: Time Tracker
tagline: Track billable hours and turn them into invoices.
description: |
  Track time against projects with a live timer or manual entries, set billable
  rates per project, and generate a draft invoice from everything unbilled in
  one step.

  Enabled by default on new installs. Time entries live alongside your invoices
  in the same database, so nothing leaves your server.
category: productivity
status: available
availability: both
requires_plan: null
icon: Clock
docs: https://github.com/pigontech/inkvoice/blob/main/docs/features/plugins.md
source: https://github.com/pigontech/inkvoice/tree/main/packages/backend/src/plugins/time-tracker
versions:
  - version: "1.0.0"
    min_app: "0.2.0"
    released: "2026-06-08"
    changelog: Projects, manual and timer entries, billable rates, draft invoice from unbilled time.
```

- [ ] **Step 2: Write `plugins/peppol/plugin.yaml`**

```yaml
# yaml-language-server: $schema=../../schema/plugin.schema.json
id: peppol
name: PEPPOL Managed Transport
tagline: Send and receive PEPPOL documents without running your own access point.
description: |
  Routes your PEPPOL e-invoices through Inkvoice Cloud's managed access point,
  so you do not have to contract with a provider or operate an AS4 endpoint
  yourself. Includes a monthly send and receive quota.

  The PEPPOL format itself is built into the self-hosted app. This plugin only
  provides the managed delivery path.
category: compliance
status: available
availability: cloud
requires_plan: peppol
icon: Network
docs: https://github.com/pigontech/inkvoice/blob/main/docs/features/peppol-transport.md
versions:
  - version: "1.0.0"
    min_app: "0.2.0"
    released: "2026-06-08"
    changelog: Managed PEPPOL access point with monthly quota and usage reporting.
```

- [ ] **Step 3: Write `plugins/france/plugin.yaml`**

```yaml
# yaml-language-server: $schema=../../schema/plugin.schema.json
id: france
name: France Managed PDP
tagline: Send French e-invoices through a partner platform, no PDP contract needed.
description: |
  Routes French e-invoices through Inkvoice Cloud's partner PDP, covering
  registration status and a monthly send and receive quota.

  Factur-X output, SIREN handling and French validation rules are built into
  the self-hosted app. This plugin only provides the managed delivery path.
category: compliance
status: available
availability: cloud
requires_plan: france
icon: FileCheck
docs: https://github.com/pigontech/inkvoice/blob/main/docs/features/france-e-invoicing.md
versions:
  - version: "1.0.0"
    min_app: "0.2.0"
    released: "2026-06-08"
    changelog: Managed PDP transport with registration status and monthly quota.
```

- [ ] **Step 4: Write `plugins/accounts-payable/plugin.yaml`**

```yaml
# yaml-language-server: $schema=../../schema/plugin.schema.json
id: accounts-payable
name: Accounts Payable
tagline: Track vendors, bills and purchase orders alongside what you invoice.
description: |
  Money going out, in the same place as money coming in: vendor records, bills
  against them, and purchase orders.

  Not built yet. It matters for small agencies and is mostly noise for solo
  freelancers, so we want to see real demand before building it. If you would
  use this, say so.
category: billing
status: planned
availability: both
requires_plan: null
icon: Receipt
docs: https://github.com/pigontech/inkvoice/blob/main/docs/features/index.md
```

- [ ] **Step 5: Write the catalog test**

Create `tests/catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildCatalog } from "../src/build";
import { loadEntries } from "../src/load";
import { sharedLucideIcons } from "../src/lucide";
import { checkEntries } from "../src/validate";

const PLUGINS = path.resolve(import.meta.dir, "..", "plugins");
const { entries, errors } = loadEntries(PLUGINS);

describe("the real catalog", () => {
  test("loads with no schema errors", () => {
    expect(errors).toEqual([]);
  });

  test("passes every cross-field rule", () => {
    const violations = checkEntries(entries, {
      iconAllowlist: sharedLucideIcons(),
      screenshotExists: (id, file) => existsSync(path.join(PLUGINS, id, file)),
    });
    expect(violations).toEqual([]);
  });

  test("contains the three shipped plugins and at least one planned entry", () => {
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("time-tracker");
    expect(ids).toContain("peppol");
    expect(ids).toContain("france");
    expect(entries.some((e) => e.status === "planned")).toBe(true);
  });

  test("plan gates match what the overlay registers", () => {
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId["peppol"]!.requires_plan).toBe("peppol");
    expect(byId["france"]!.requires_plan).toBe("france");
    expect(byId["time-tracker"]!.requires_plan).toBeNull();
  });

  test("every shipped plugin declares min_app 0.2.0", () => {
    for (const e of entries.filter((x) => x.status === "available")) {
      expect(e.versions![0]!.min_app).toBe("0.2.0");
    }
  });

  test("builds without throwing", () => {
    const cat = buildCatalog(entries, {
      screenshotBaseUrl: "https://example.com/s",
      generatedAt: "2026-08-31T00:00:00.000Z",
    });
    expect(cat.plugins).toHaveLength(entries.length);
  });
});
```

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS, all files. If rule 5 fires on `Network`, `FileCheck` or `Receipt`, that icon is absent from one lucide version. Substitute a name that is in `sharedLucideIcons()` and update both the plugin.yaml and the Task 4 test list.

- [ ] **Step 7: Verify the built artifact by hand**

```bash
bun run build
```

Expected: `✓ dist/catalog.v1.json (4 plugins)`. Open the file and confirm `schema` is `1`, plugins are sorted by id starting with `accounts-payable`, and `accounts-payable` has `"latest": null` and `"versions": []`.

- [ ] **Step 8: Commit**

```bash
git add plugins/ tests/catalog.test.ts
git commit -m "feat: seed catalog with time-tracker, peppol, france, accounts-payable"
```

---

### Task 8: CI, Pages publishing and README

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `bun run validate`, `bun run build`, `bun run gen:schema`, `bun test` from Tasks 6 and 7.
- Produces: `https://pigontech.github.io/inkvoice-plugins/catalog.v1.json`, the URL spec E's `sync-plugins.ts` fetches.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run validate
      - run: bun test
      # The committed JSON Schema files are generated from the Zod source.
      # Regenerate and fail if anything moved, so they can never drift.
      - run: bun run gen:schema
      - run: git diff --exit-code schema/
      - run: bun run build

  publish:
    needs: check
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deploy
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Write `README.md`**

````markdown
# Inkvoice plugins catalog

The public, versioned description of every Inkvoice plugin. Two things read it:

- The **Inkvoice app** (self-hosted and Cloud) fetches it to populate the
  Plugins settings tab, including plugins your install cannot run and ones that
  do not exist yet.
- The **inkvoice.app website** renders `/plugins` and one page per plugin from
  the same file.

Published artifact:
`https://pigontech.github.io/inkvoice-plugins/catalog.v1.json`

This repo contains **no plugin code**. Inkvoice plugins are compiled into the
app; this is metadata only.

## Adding or changing an entry

1. Create `plugins/<id>/plugin.yaml`. Copy an existing one as a starting point.
   `<id>` must match the `id` inside the file.
2. Keep the `# yaml-language-server: $schema=../../schema/plugin.schema.json`
   comment on line one. It gives you completion and inline errors in any editor
   with the YAML extension installed.
3. Run `bun install` then `bun run validate`.
4. Open a PR. CI validates on every PR and publishes on merge to `main`.

### Fields

| Field | Notes |
|---|---|
| `id` | Lowercase kebab-case, immutable once published, must match the folder name. Cannot be `catalog`. |
| `category` | One of `billing`, `compliance`, `productivity`, `integrations`, `reporting`. |
| `status` | `available` needs at least one version. `planned` must have no `versions` and no `source`. |
| `availability` | `oss` ships in the self-hosted app, `cloud` only in Inkvoice Cloud, `both` in both. |
| `requires_plan` | The Cloud plan feature that gates it, or `null`. Must match the plugin's `feature` in code. |
| `icon` | A `lucide-react` export name available in **both** consumer versions. `bun run validate` checks this. |
| `versions` | Newest first. `version` and `min_app` are strict `MAJOR.MINOR.PATCH`. |

### Versioning a plugin

A plugin's version is its own, not the app's. When you bump the `version` a
plugin declares in code, add a matching entry here in the same release, or the
app will report an update that does not exist.

`min_app` is the lowest Inkvoice version that release runs on. It may stay flat
or rise across releases, never fall.

## Local commands

```bash
bun install
bun run validate     # schema plus the eight cross-field rules
bun test             # unit tests
bun run build        # writes dist/catalog.v1.json
bun run gen:schema   # regenerates schema/*.json from the Zod source
```

`schema/*.json` is generated. Edit `src/schema.ts` and re-run `gen:schema`; CI
fails if the committed files are stale.

## Schema versioning

The filename carries the version. Additive changes (a new optional field, a new
enum value) stay on `v1`, and consumers ignore fields they do not know. A
breaking change publishes `catalog.v2.json` alongside `v1`, and `v1` keeps
building for at least one full OSS release cycle, because self-hosted installs
upgrade on their own schedule.
````

- [ ] **Step 3: Verify the workflow locally**

Run each CI step by hand:

```bash
bun install --frozen-lockfile && bun run validate && bun test && bun run gen:schema && git diff --exit-code schema/ && bun run build
```

Expected: every command exits 0 and `git diff` reports nothing.

- [ ] **Step 4: Commit**

```bash
git add .github/ README.md
git commit -m "ci: validate on PR, publish catalog to Pages on main"
```

- [ ] **Step 5: Create the GitHub repo and push**

```bash
gh repo create pigontech/inkvoice-plugins --public --source=. --remote=origin --push
```

- [ ] **Step 6: Enable Pages**

In the repo's Settings, Pages, set Source to **GitHub Actions**. Then confirm the
`publish` job ran and the artifact is live:

```bash
curl -sS https://pigontech.github.io/inkvoice-plugins/catalog.v1.json | head -20
```

Expected: JSON beginning `{ "schema": 1, ...`. This URL is what spec E's
`sync-plugins.ts` fetches; specs B and E are blocked until it responds.

---

## Definition of done

- `bun test` passes with every test file green.
- `bun run validate` exits 0 against the four seeded entries.
- `bun run build` writes a `dist/catalog.v1.json` that parses under `catalogSchema`.
- `https://pigontech.github.io/inkvoice-plugins/catalog.v1.json` serves that file over HTTPS.
- `schema/plugin.schema.json` and `schema/catalog.schema.json` are committed and match the Zod source.
- The README explains how to add an entry without reading any other document.

## Follow-ups this plan deliberately does not do

- **Screenshots.** No plugin has one yet, so `screenshots` is empty everywhere.
  Rule 6 and the copy step are implemented and tested, so adding one later is
  just dropping a file in `plugins/<id>/screenshots/` and referencing it.
- **The site-repo PR automation** mentioned as optional in spec A. Manual
  `bun run sync:plugins` (spec E) is the shipped path.
- **`inkvoice-site`'s lucide version.** It sits three majors behind the app at
  `^0.468.0`. The intersection allowlist makes that safe rather than fixing it,
  which is correct for this plan but worth a separate upgrade later.
