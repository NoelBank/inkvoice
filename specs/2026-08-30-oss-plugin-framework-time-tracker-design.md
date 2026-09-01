# OSS Plugin Framework + Time Tracker: Design Spec

**Date:** 2026-08-30
**Status:** Draft, awaiting review
**Repos touched:** `inkvoice/` (primary), `inkvoice-cloud/` (overlay rework)
**Owner:** Baris

---

## 1. Summary

Time tracking exists today as an Inkvoice Cloud plugin (`cloud/plugins/time-tracker`): projects, per-user timers, manual entries, summaries, and "create invoice from unbilled time" that reuses the OSS `createInvoice()`. This spec moves the entire time-tracking feature into the OSS (MIT) repo and, with it, the plugin framework it needs, so OSS gets a first-class plugin system and the cloud overlay stops owning duplicate framework code.

Locked decisions:

| Decision | Choice |
|---|---|
| Architecture | **One plugin stack, owned by OSS.** OSS gains the backend + frontend plugin framework; cloud registers its premium plugins into the OSS registry and injects plan-gating policy. One catalog, one enablement store, one Settings → Plugins tab. |
| API path | `/api/v1/plugins/time-tracker` stays (no path churn for existing tenants and API-token scripts). |
| Entry visibility | **Non-admins see and edit only their own entries; admins see and manage all.** Projects: read for all, mutations admin-only. Billing time into an invoice requires `invoices:create`. |
| Default state | Time tracker is **enabled by default** on fresh OSS installs; admin can disable it in Settings → Plugins. |
| Data continuity | Cloud tenant tables (`tt_projects`, `tt_time_entries`) are moved **byte-identical**; same `plugin_schema_migrations` rows, same `enabled_plugins` KV key, same API paths. No data migration. |
| Cloud premium later | Team timesheets/approvals, advanced reports/exports, and global header timer become cloud plugins/hooks on top of the OSS feature, not forks of it. |

## 2. Goals

1. A self-hosted OSS user gets time tracking (projects, timer, entries, billing time into invoices) enabled by default, disable-able in Settings → Plugins.
2. OSS has a reusable, statically compiled plugin framework: backend registry, per-plugin migrations, enablement KV, catalog API, and the frontend pieces (catalog tab, nav gate, route guard).
3. The cloud overlay consumes the same framework; its premium plugins (`france`, `peppol`) register into the OSS registry, and plan gating is injected as policy rather than living in framework code.
4. Future premium features extend time tracking without forking OSS code: they read the same tables or use the declared extension hooks.

## 3. Non-goals

- **Dynamic/third-party plugin loading.** Plugins remain statically compiled-in official modules, exactly like cloud today. No marketplace, no runtime discovery.
- **Per-user time entry RBAC in OSS.** Non-admins are self-scoped; admins see all. Finer grants (a `time_entries` resource in `user_permissions`) are deferred until someone asks.
- **Client-facing time views.** Nothing in the client portal or public pages shows time data.
- **Writing the premium features now.** §10 declares the seams; nothing speculative is built.
- **Cloud premium feature parity work in this cycle.** Phase 2 is framework relocation only.

## 4. What already exists

Grounded in the current tree.

| Concern | Where | State |
|---|---|---|
| Cloud time-tracker backend | `inkvoice-cloud/packages/backend/src/cloud/plugins/time-tracker/{migrations,service,index}.ts` | Complete: projects CRUD, entries CRUD + duration normalization, per-user timer (one running per user), per-project summary, `createInvoiceFromUnbilled()` reusing OSS `createInvoice()`. Port target. |
| Cloud plugin framework | `cloud/plugins/{registry,gate,routes,plugin-settings.service}.ts` | Registry, enablement (`enabled_plugins` JSON array in OSS `settings` KV), 404 gate + `requireFeature`, catalog/toggle API. Port target for OSS. |
| Cloud plugin frontend framework | `inkvoice-cloud/packages/frontend/src/plugins/` | `pluginFetch`, registry, `use-plugins.store`, `PluginGuard`, `install-nav-gate`, `PluginsSettingsTab`. Port target for OSS. |
| Cloud time-tracker frontend | `.../plugins/time-tracker/` (page, api, i18n, index) | 1,700 lines. Port target; add admin-only user filter and permission-aware billing card. |
| OSS route registry | `packages/frontend/src/route-registry.ts` | `registerRoute()` with scopes, overlay-replaceable. |
| OSS nav registry | `packages/frontend/src/nav-registry.ts` | `registerNavItem()` with `pluginId` visibility gate + `setNavGateHook()`. OSS default is allow-all; Sidebar renders an Extensions section. |
| OSS slot registry | `packages/frontend/src/components/layout/slot-registry.tsx` | `header-right` slot already exists: future global header timer needs zero OSS changes. |
| OSS settings-tab registry | `packages/frontend/src/pages/settings-tab-registry.tsx` | `registerSettingsTab()`; used for the Plugins tab. |
| OSS i18n merge | `packages/frontend/src/i18n/index.ts` | `registerTranslations()` deep-merges at bootstrap. `en.ts` is the type source. |
| OSS route mounting | `packages/backend/src/app.ts` `createApp()` | `CreateAppOptions.registerRoutes` + ordered protected mounting. Plugin mounting lands here. |
| OSS auth | `middleware/auth.ts` | `authMiddleware` (JWT + API tokens, tenant-aware), `requirePermission(resource, action)` with role fallback (line 117). |
| OSS permission types | `types/user.ts` `Resource`/`Action` | `invoices`/`create` already valid. |
| Migration runner | `packages/backend/src/database/migrations.ts` | Versioned core migrations (latest v26). Plugin migrations will be tracked separately; no core bump needed. |
| Demo seed | `packages/backend/src/database/seed.ts` `seedDemoDataIfEmpty()` | Seeds sample dataset on empty DB in DEMO_MODE. Gains time entries. |
| Overlay boot | `inkvoice-cloud/packages/backend/src/cloud/init.ts` | Mounts plugins manually (lines 173-177), runs `migrateAllTenants()` per tenant. Rework target. |
| Overlay frontend boot | `.../cloud-registrations.ts` | Imports `./plugins` barrel before `<App>`. Rework target. |

## 5. Architecture: one plugin stack, owned by OSS

```
OSS (MIT), new
  backend/src/plugins/
    registry.ts        BackendPlugin interface + registerBackendPlugin()
    settings.ts        enablement via `enabled_plugins` KV
    gate.ts            404-when-disabled + injected feature policy
    routes.ts          GET/PUT /api/v1/plugins (catalog, admin toggle)
    runner.ts          runPluginMigrations(db) + plugin_schema_migrations DDL
    index.ts           barrel (imports official OSS plugins)
    time-tracker/      migrations.ts, service.ts, index.ts
  frontend/src/plugins/
    api.ts, registry.ts, use-plugins.store.ts, PluginGuard.tsx,
    install-nav-gate.ts, PluginsSettingsTab.tsx, i18n.ts, index.tsx (barrel)
    time-tracker/      TimeTrackingPage.tsx, api.ts, i18n.ts, index.tsx

Cloud overlay, after the OSS submodule bump
  cloud/plugins/{france,peppol}/          keep; import OSS's registry
  cloud/plugins/{registry,gate,routes,
    plugin-settings.service,time-tracker} DELETED
  frontend/plugins/france/                keep; registers into OSS framework
  frontend/plugins/{framework + time-tracker}  DELETED
```

Interop rule: the OSS `BackendPlugin` interface carries `feature?: string` as **inert metadata**. The OSS gate ignores it by default. At boot, an overlay may call `setPluginFeatureGate(fn)`; the gate then routes any plugin declaring a feature through the overlay's policy (cloud: existing `requireFeature` plan middleware). OSS never imports cloud code, mirroring existing injection patterns (`setRecurringLimitChecker`, `setTenantSmtpResolver`, `setResetUrlBuilder`).

One catalog (`GET /api/v1/plugins`), one `enabled_plugins` KV key, one Plugins settings tab, one nav gate. In cloud, the OSS `settings.service` is ALS tenant-bound, so enablement semantics stay per-tenant with zero changes.

## 6. Backend framework (OSS)

- **`registry.ts`**: `BackendPlugin { id, routes: Hono, migrations: PluginMigration[], defaultEnabled?, feature? }`; `registerBackendPlugin()` replaces by id (HMR-safe); `getBackendPlugins()`, `getBackendPlugin(id)`. `PluginMigration { version, name, up(db) }`.
- **`settings.ts`**: port of cloud's `plugin-settings.service.ts`: `getEnabledPluginIds()` (unset key + `defaultEnabled` ⇒ on), `isPluginEnabled()`, `setPluginEnabled()`. Same `enabled_plugins` key.
- **`gate.ts`**: `pluginGate(plugin)`: 404 `{ success:false, error:"Plugin not enabled", plugin }` when disabled; if the plugin declares `feature`, delegate to the injected feature gate (default: no-op pass-through).
- **`routes.ts`**: `GET /api/v1/plugins` returns `{ plugins: [{ id, feature, enabled }], enabled: [...] }` for any authed user; `PUT /api/v1/plugins/:id` toggles (admin only, 404 unknown id). Identical response shape to cloud's current API so the store ports unchanged.
- **`runner.ts`**: `runPluginMigrations(db)`: `CREATE TABLE IF NOT EXISTS plugin_schema_migrations (plugin_id TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (plugin_id, version))`, then applies pending versions per plugin in order. Called from OSS `index.ts` after `runMigrations()` and before `seed()`; cloud's `tenant-migrations.ts` calls the same runner per tenant DB. **No core migration version bump.**
- **Mounting in `createApp()`**: after core protected routes, for each registered plugin `app.use("/api/v1/plugins/<id>/*", pluginGate(plugin))` then `app.route("/api/v1/plugins/<id>", plugin.routes)`. OSS `app.ts` imports the plugins barrel so the registry is populated at import time (OSS barrel imports time-tracker; cloud's `cloud/plugins/index.ts` side-effect-imports france/peppol into the same registry before `createApp` runs). Cloud `init.ts` drops its manual mounting block.
- Boot order (OSS standalone): imports populate registry → `initDatabase` → `runMigrations` → `runPluginMigrations` → `seed()` → `createApp()`.

## 7. Time-tracker plugin backend (OSS)

Folder `packages/backend/src/plugins/time-tracker/`. Port of cloud's three files with these deltas:

- **Schema unchanged.** `tt_projects` and `tt_time_entries` exactly as cloud migration v1 (same table/column names, `tt_` prefix kept, same indexes, same version number `time_tracker_tables`). Existing cloud tenant DBs already have the rows in `plugin_schema_migrations`, so the runner no-ops for them.
- **Ownership scoping (new).** All entry-level service functions take an actor `{ userId, isAdmin }`:
  - `listEntries`, `getSummary`, `getActiveTimer`: non-admin queries are forced to `user_id = ?` (summary gains a per-user WHERE and keeps its current shape).
  - `updateEntry`, `deleteEntry`: verify `user_id` ownership first; admins bypass.
  - Admins see and manage everything.
- **Project permissions.** Create/update/archive/delete are admin-only (enforced in routes via a small admin check mirroring `app.ts`'s `adminOnly`); all authed users read projects. `startTimer` and manual entry creation stay open to all users (self-scoped by construction: `user_id` always from context, never from the request body).
- **Invoice from unbilled time.** Route additionally wrapped in `requirePermission("invoices", "create")`. Cross-user aggregation unchanged: that is the point of billing.
- **`setTimeEntryEditGuard(fn)` hook** in the service (default: allow). Called before entry update/delete with the entry + acting user; a rejection aborts with a 4xx. Reserved for cloud timesheet approvals/locks (§10). The hook is declared and tested in OSS but has no non-trivial default behavior.
- API paths unchanged: `/projects`, `/entries`, `/timer/{active,start,stop}`, `/summary`, `/invoice`.

## 8. Frontend (OSS)

Port cloud's plugin frontend framework into `packages/frontend/src/plugins/` unchanged in behavior (`pluginFetch`, store with `enabled`/`loaded`/`ensureFetched`, `PluginGuard` redirect, nav gate hide-until-loaded, Plugins tab listing catalog with admin toggles). OSS `registrations.tsx` imports the barrel; the barrel installs the nav gate and registers the Plugins settings tab.

Time-tracker frontend changes on top of the port:

- Admin-only **user filter** on the entries list (server enforces scoping anyway; the filter is only shown when `user.is_admin`).
- **"Create invoice from unbilled time"** card rendered per the same rule the UI uses for invoice creation (admin or `invoices:create` permission), and the backend rejects others with 403.
- i18n: `time_tracker.*` namespace registered for all five languages. `en`/`tr` carry over from cloud verbatim; `es`/`de`/`fr` written fresh and flagged for review.
- Nav item: `/time-tracking`, label `time_tracker.nav`, Timer icon, section `nav.extensions`, `pluginId: "time-tracker"`. Route: protected scope, wrapped in `PluginGuard`.
- OSS Plugins tab metadata: name/description keys + `defaultEnabled: true` state surfaced from the catalog.

## 9. Demo seed

`seedDemoDataIfEmpty()` additionally seeds, only on an empty database in DEMO_MODE:

- 2 projects: one linked to the demo customer with a default hourly rate, one unlinked/internal.
- ~15 completed entries spread over the previous two weeks, mixed billable/non-billable and durations, all unbilled (so the timer card, unbilled preview, and invoice-from-time flow are all demonstrable).
- No running timer in seeds.

## 10. Premium seams (declared, not built)

- **Team timesheets / approvals (cloud).** Own cloud tables (submission state, approval status, locked periods). OSS respects locks via the `setTimeEntryEditGuard` hook: the cloud overlay installs a guard that rejects edits to approved/locked entries.
- **Advanced reports/exports (cloud).** A separate cloud plugin (own router, own nav item) reading `tt_*` via `getDb()`: per-user breakdowns, billability trends, timesheet exports. Zero OSS coupling.
- **Global header timer (cloud).** Registers into the existing `header-right` slot; the OSS page-scoped timer card stays as-is.
- **Timer UX + integrations (future).** The service layer keeps timer logic in pure functions over `tt_time_entries`, so webhooks/calendar sync can be added as plugins without schema churn.

## 11. Testing

Backend (`bun:test`, in-memory SQLite, `app.request()` integration style):

- Framework: registry idempotency (re-register replaces by id); enablement defaults and toggle round-trip; gate returns 404 when disabled; feature gate hook invoked only when `feature` is declared (default no-op); `runPluginMigrations` idempotent, including a pre-seeded `plugin_schema_migrations` table simulating upgraded cloud tenants; catalog API shape + admin-only toggle (403 non-admin).
- Time tracker: ported service tests (projects, entries + duration normalization, timer, summary, invoice-from-unbilled) plus new ownership tests: non-admin lists only own entries/summary, cross-user update/delete denied, admin sees/manages all, project mutation 403 for non-admin, `user_id` always from context, invoice-from-time requires `invoices:create` (403 without).
- Cloud (after phase 2): re-point `time-tracker.test.ts` at OSS modules; add a catalog-merge test asserting `france`, `peppol`, `time-tracker` all register; keep `plugin_schema_migrations` continuity test.

Frontend: OSS has no test suite. Add a minimal registry test (routes/nav/meta registered after importing the plugins barrel) if the harness permits without new dependencies; otherwise rely on `bun run check`.

## 12. Risks / assumptions

- **API-token scopes.** `apiTokenScopeMiddleware` runs on `/api/v1/*`. Plugin paths must behave sanely under scoped tokens; behavior will be verified during implementation (expected: existing tokens list already models resources; `plugins/<id>` may need explicit scope mapping or default-deny documentation).
- **Export/backup coverage.** OSS export should include `tt_*` tables; confirmed during implementation.
- **Translations.** `es`/`de`/`fr` strings are machine-assisted and flagged for human review.
- **Existing cloud tenants** that explicitly disabled time-tracker keep it disabled (same key, same ids). No visible tenant UX change except toggles now render from OSS-built components.
- **Submodule timing.** Cloud rework is blocked on OSS merge + submodule bump (`bun run sync` in submodule mode). The cloud working copy must be in submodule mode before sync (`bun run dev:link:status` first).
- **Sync contract.** All OSS changes go through the normal OSS repo; `vendor/inkvoice-oss/` is never edited directly (AGENT-CONTRACT.md). The plugin framework is documented for future plugin authors in `docs/features/plugins.md` (OSS), following the existing feature-doc convention.

## 13. Sequencing

1. **OSS**: plugin framework → time-tracker port + scoping → demo seed → tests → `bun run check` green → commit/push.
2. **Cloud**: verify submodule mode → `bun run sync` (bump submodule) → overlay rework (delete duplicates, register france/peppol into OSS registry, install feature gate) → `bun run typecheck` + `bun run test` green.
3. **Optional, separate**: `inkvoice-site` marketing note ("Time tracking is now free in OSS").

## 14. Decisions intentionally deferred

- Exact scope semantics for API tokens on plugin paths (decided during implementation, documented in `docs/features/plugins.md`, written with the framework in step 1).
- Whether advanced cloud reports live under a `feature` gate or a separate plugin id (decided when that plugin is designed).
- Full `time_entries` RBAC resource (only if real demand appears).
