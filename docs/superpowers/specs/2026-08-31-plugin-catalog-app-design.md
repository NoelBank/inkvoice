# Plugin catalog in the app (specs B + C): Design

Date: 2026-08-31
Status: Approved (design review)
Repo: `pigontech/inkvoice` (OSS, MIT)
Depends on: `2026-08-31-plugin-catalog-contract-design.md` (spec A)
Companion: cloud alignment (spec D) lives in `pigontech/inkvoice-cloud`

## Motivation

The Plugins settings tab today is a flat list of whatever the running build
registered, with an Enable/Disable button and nothing else. On a self-hosted
OSS install that is exactly one row. There is no search, no filtering, no
notion of a version, and a plugin's own settings have nowhere to live, which is
why the overlay's France plugin ended up registering a competing top-level
settings tab.

This spec turns that tab into the single place a plugin is governed: discovery,
enablement, version state and per-plugin configuration in one surface, backed by
the public catalog from spec A.

## Decisions (from design review)

| Question | Decision |
|---|---|
| Version semantics | Catalog-only. The app compares the version it ships against the catalog's latest and links to a release, never updates in place. |
| Catalog transport | Backend-proxied, TTL cached, with a committed bundled snapshot fallback. The frontend calls exactly one endpoint. |
| Default posture | Remote catalog fetch is **on by default**, disclosed in the UI, disabled by clearing one setting. |
| Plugin settings | Master/detail inside the Plugins tab at `/settings/plugins/:id`. Plugins no longer register top-level settings tabs. Core feature tabs are unaffected (see "What is not a plugin setting"). |
| Tab scope | Installed plugins plus catalog entries this build cannot run (shown with a reason) plus `planned` entries (shown with a demand vote). |
| Naming | Standardise on "Plugins". The sidebar section label changes from "Extensions". |

## Part 1: Backend

### 1.1 Plugins declare a version

`BackendPlugin` in `packages/backend/src/plugins/registry.ts` gains:

```ts
/** Strict semver of this plugin's own implementation, independent of the
 *  app version. Compared against the catalog's latest to drive the update
 *  badge. Bump it whenever the plugin's behaviour changes. */
version: string;
```

Required, not optional. An optional field would silently produce plugins that
can never show update state, which is the exact gap this work exists to close.
Time Tracker ships `"1.0.0"`.

`registerBackendPlugin` also gains a guard: ids in `RESERVED_PLUGIN_IDS`
(`["catalog"]`) throw at registration. See 1.4 for why.

### 1.2 Catalog service

New `packages/backend/src/plugins/catalog.service.ts`.

**Settings keys** (all in the existing settings KV, so this stays per-tenant in
the overlay with no extra work):

| Key | Meaning |
|---|---|
| `plugin_catalog_url` | Source URL. Unset means the built-in default. **Empty string disables all catalog egress**, votes included. |
| `plugin_catalog_cache` | Last successful payload, verbatim JSON. |
| `plugin_catalog_synced_at` | ISO timestamp of that success. |
| `plugin_catalog_votes` | Last fetched `{id: count}` map. |

Default URL constant: `https://inkvoice.app/plugins/catalog.v1.json`.
Votes come from `https://inkvoice.app/api/plugin-votes` (spec E).

**Resolution order** for `getCatalog()`:

1. Cache fresher than the 6h TTL, and `schema === 1`. Use it.
2. Otherwise fetch remote (5s timeout, single attempt, no retry loop). On
   success validate `schema === 1`, write cache and `synced_at`, use it.
3. On failure, use the stale cache if there is one.
4. Otherwise use the **bundled snapshot**,
   `packages/backend/src/plugins/catalog-snapshot.json`, committed to the repo
   and regenerated as a release step.

The result carries its own provenance so the UI can be honest about it:
`{ source: "remote" | "cache" | "snapshot", syncedAt: string | null, error: string | null }`.

Consequences worth stating plainly: the tab is never empty, never spins
indefinitely, and works fully air-gapped. A remote fetch only ever *improves*
the data. A failed fetch is surfaced as a line of text, never as an error state
that blocks the page.

When `plugin_catalog_url` is the empty string, steps 2 and 3 are skipped
entirely and `source` is always `snapshot`. No socket is opened.

### 1.3 Version comparison

New `packages/backend/src/plugins/semver.ts`: `compare(a, b)`, `gt`, `gte` over
strict `MAJOR.MINOR.PATCH`. No prerelease or build metadata, because the catalog
schema forbids them. Roughly twenty lines and fully unit-tested; adding a
dependency for this would not be justified.

### 1.4 Endpoints

Three new routes on `pluginsAdminRoutes`, all under a reserved `catalog`
segment:

```
GET  /api/v1/plugins/catalog          # the merged payload (any authed user)
POST /api/v1/plugins/catalog/refresh  # force re-sync (admin only)
POST /api/v1/plugins/catalog/vote     # body { id }, proxied to spec E
```

**Why `catalog` is reserved.** Plugin routers mount at
`/api/v1/plugins/<id>/*`. A plugin with id `catalog` would shadow these, and
putting the vote route at `/api/v1/plugins/:id/vote` would collide with any
plugin that defines its own `vote` route. Reserving one id and passing the
plugin id in the vote body avoids both collisions. `RESERVED_PLUGIN_IDS` is
enforced in `registerBackendPlugin` and mirrored as a schema rule in the
catalog repo.

**Why votes are proxied.** Keeping the vote POST on the same server-side path as
the catalog fetch means one egress route, one opt-out setting, no CORS, and no
browser-originated request to `inkvoice.app` from a self-hosted install.
Clearing `plugin_catalog_url` disables voting as a consequence rather than
requiring a second switch.

### 1.5 The merged payload

`GET /api/v1/plugins/catalog` returns a **union** of the catalog and the local
registry. Locally registered plugins absent from the catalog are still listed,
built from registry data alone, so a fork that adds its own plugin is not
erased by an upstream catalog.

Per entry:

```ts
{
  id, name, tagline, description, category, icon, docs, source, screenshots,
  status: "available" | "planned",
  availability: "oss" | "cloud" | "both",
  installed: boolean,           // present in the local registry
  installedVersion: string | null,
  latestVersion: string | null,
  updateAvailable: boolean,     // installed && latest > installed
  updateRequiresApp: string | null, // latest.min_app when APP_VERSION is below it
  enabled: boolean,
  blockedReason: null | "cloud_only" | "requires_plan" | "planned",
  votes: number,
}
```

`blockedReason` answers exactly one question: why is there no working enable
switch. It is `"cloud_only"` when the catalog says `availability: "cloud"` and
the plugin is not in the local registry, `"planned"` for planned entries, and
`"requires_plan"` when the overlay's entitlement resolver denies it. Nothing
ever renders an Enable switch it cannot honour.

`updateRequiresApp` is kept separate from `blockedReason` deliberately: needing
a newer app to get a newer *plugin* does not block enabling the plugin you
already have.

### 1.6 Entitlement seam for the overlay

OSS ships no plans, so it cannot evaluate `requires_plan`. Following the
existing `feature-gate.ts` pattern:

```ts
// packages/backend/src/plugins/entitlement.ts
export type PluginEntitlementCheck = (plan: string) => boolean;
export function setPluginEntitlementCheck(fn: PluginEntitlementCheck | null): void;
```

Default is null, meaning everything is entitled, so OSS behaviour is unchanged.
The overlay installs its resolver at boot alongside `setPluginFeatureGate`.

## Part 2: Frontend

### 2.1 Registry gains a settings slot

`FrontendPlugin` in `packages/frontend/src/plugins/registry.ts` gains:

```ts
/** Rendered in the plugin's detail view at /settings/plugins/<id>.
 *  Plugins must not register their own top-level settings tab. */
settings?: ComponentType;
```

The `nameKey` / `descriptionKey` fields stay for offline rendering, but the
catalog's `name` and `tagline` win when present, so a new plugin description
does not require an app release.

#### What is not a plugin setting

"Plugins do not register top-level settings tabs" applies to **plugins**, not to
core features that happen to be adjacent to one. The distinction is ownership,
and getting it wrong would bury core configuration behind a paid add-on:

- **E-invoicing regime settings are core OSS.** `peppol_enabled`,
  `france_enabled` and their transport and sender fields are read by
  `einvoice-transports/registry.ts`, `xml/build-data.ts` and
  `einvoice-validator.service.ts`. They work with any transport, including
  self-hosted ones, on an install with no plugins at all. The existing OSS
  `peppol` settings tab, registered in `registrations.tsx` and hidden until
  `peppol_enabled` is on, is the correct pattern and **stays exactly as it is**.
- **Managed transport plugins are plugins.** The overlay's `peppol` and
  `france` plugins register a driver into the OSS transport registry and are
  plan-gated. What they own is their own status, quota and usage, and that
  belongs in the plugin detail view.

An earlier draft of this design proposed collapsing `france_enabled` into
plugin enablement on the assumption that they were duplicate switches. They are
not, and doing so would disable French e-invoicing for any self-hoster using
their own transport. `france_enabled` stays a core setting.

Concretely: a plugin's `settings` component configures the plugin. Settings the
app would still need if the plugin did not exist belong to core and keep their
own home.

### 2.2 Store

`use-plugins.store.ts` moves from `GET /api/v1/plugins` to
`GET /api/v1/plugins/catalog` and holds the full entry list plus catalog
provenance. `setEnabled` still uses `PUT /api/v1/plugins/:id` and patches the
entry in place. Adds `refresh()` (force re-sync) and `vote(id)`.

`isEnabled` and the nav gate keep working off the same store, so
`PluginGuard` and `install-nav-gate` need no changes.

### 2.3 Master view

`PluginsSettingsTab.tsx` gains a toolbar and two layouts:

- **Search**: client-side, case-insensitive substring over name, tagline and
  category. Client-side is correct here; the catalog is a few dozen entries
  already in memory, and a server round trip per keystroke would be worse in
  every dimension.
- **Category filter**: a `Select` over the catalog's closed category enum, plus
  All.
- **Status chips**: All / Enabled / Disabled / Planned.
- **View toggle**: grid or list, persisted to `localStorage` under
  `inkvoice.plugins.view`, defaulting to grid.

Grid cards show icon, name, tagline, tier or reason chip, enable switch and
update badge. List rows show the same information densely, closer to today's
layout. Both are the same data with the same affordances.

Empty states are distinct and say something useful: no plugins at all, versus
no plugins matching the current search and filters with a control to clear them.

Footer line, always visible:
*"Catalog synced 2 hours ago · inkvoice.app · Refresh · Turn off"*, or
*"Using bundled catalog. Last sync failed: &lt;reason&gt;"*, or
*"Remote catalog is turned off."* This is the transparency half of the
on-by-default decision and is not optional.

### 2.4 Detail view

Route `/settings/plugins/:pluginId`, following the existing
`/settings/templates/:id/edit` sub-route pattern exactly:

- `App.tsx` adds a `/settings/plugins/:pluginId` route rendering `<Settings />`
  inside `<AdminRoute>`.
- `Settings.tsx` adds an `isPluginSubRoute` check beside `isTemplateSubRoute`
  so the tab resolves to `plugins`.
- `PluginsSettingsTab` renders the detail view instead of the master list when
  a `pluginId` param is present.

Detail contents: back link; header with icon, name, category, and
`installed 1.0.0 → latest 1.1.0`; the enable switch or the blocked reason;
an update banner when `updateAvailable`, naming the required app version and
linking to the release notes; the description; docs and source links; then the
plugin's `settings` component if it declared one.

A `planned` entry renders no switch and no settings. It renders the description
and an "I want this" button with a live count, which posts through the vote
proxy. The button hides entirely when the remote catalog is off, because a vote
that cannot be sent should not be offered.

### 2.5 Supporting changes

- **New `components/ui/switch.tsx`.** The kit has `checkbox` but no switch, and
  enable/disable is a switch affordance, not a checkbox one.
- **Sidebar label.** `nav.extensions` becomes `nav.plugins` in all five
  languages. The tab, the API and the route paths already say "plugins"; the
  sidebar was the only holdout.
- **i18n.** New keys under `plugins.*` for the toolbar, view toggle, reason
  chips, update banner, sync line and vote button, added to all five languages
  in `plugins/i18n.ts`. Catalog-sourced text (name, tagline, description) is
  English-only by design in schema v1 and is rendered as-is.

## Testing

**Backend** (`packages/backend/src/tests/plugin-catalog.test.ts`):

- Fresh cache is used without a fetch.
- Stale cache triggers a fetch; success updates cache and `synced_at`.
- Fetch failure with a stale cache falls back to it and reports `source: "cache"`.
- Fetch failure with no cache falls back to the snapshot.
- `plugin_catalog_url` empty opens no socket and always reports `source: "snapshot"`.
- A payload with `schema: 2` is rejected in favour of the snapshot.
- Merge: catalog-only, registry-only and both-sides entries all appear, with
  correct `installed`, `enabled`, `updateAvailable` and `blockedReason`.
- `requires_plan` yields `blockedReason: "requires_plan"` only when an
  entitlement resolver denies it, and null when none is installed.
- `registerBackendPlugin({ id: "catalog" })` throws.
- Vote proxy forwards the id and returns the count; it is a no-op when the
  catalog is off.
- `semver.ts` comparison table, including `0.2.0 < 0.10.0`.

**Frontend** (`packages/frontend/src/tests/plugins-tab.test.tsx`):

- Search and filters narrow the list; clearing restores it.
- View toggle persists across remounts.
- A blocked entry renders a reason chip and no enable switch.
- A planned entry renders a vote button and no switch.
- `updateAvailable` renders the banner with the required app version.
- The detail route resolves to the right plugin and renders its settings
  component.
- The sync footer renders each of the three provenance states.

The existing `plugin-framework.test.ts` and `plugins-bootstrap.test.ts` must
keep passing; the framework's gating semantics are unchanged by this work.

## Migration and compatibility

`GET /api/v1/plugins` keeps its current shape. It is a documented endpoint and
the frontend is not its only possible consumer. The new merged view lives at a
new path rather than reshaping the old one.

Adding a required `version` to `BackendPlugin` is a compile-time break for any
downstream that registers a plugin, which today means only the cloud overlay.
Spec D covers it, and TypeScript catches it before anything ships.

## Out of scope

- Dynamic or third-party plugin installation.
- In-place plugin updates. The update path is "upgrade Inkvoice".
- Per-plugin permissions or role scoping beyond the existing admin gate.
- Localised catalog content.
