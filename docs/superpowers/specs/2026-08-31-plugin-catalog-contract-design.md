# Plugin catalog contract (spec A): Design

Date: 2026-08-31
Status: Approved (design review)
Repo: `pigontech/inkvoice-plugins` (new, public) with consumers in
`pigontech/inkvoice`, `pigontech/inkvoice-cloud`, `pigontech/inkvoice-site`

## Motivation

Inkvoice plugins are statically compiled into the app. `registerBackendPlugin()`
and `registerPlugin()` run at import time; Time Tracker ships inside the OSS
app, Peppol and France ship inside the cloud overlay. There is no dynamic
loading and the OSS backend makes no outbound calls today.

That leaves three gaps:

1. The Plugins settings tab can only ever show what the running build ships. On
   a self-hosted OSS install it lists exactly one entry (Time Tracker), which
   makes the ecosystem look empty even though four plugins exist.
2. There is no notion of a plugin version. A plugin's version is implicitly the
   app's version, so "latest version" and "update available" cannot be
   expressed.
3. The marketing site has nothing to render a plugins page from.

This spec defines the shared **catalog contract**: a public, versioned
description of every Inkvoice plugin that exists, independent of what any given
install ships. It is the foundation that specs B, C, D and E all read. It
deliberately does **not** introduce dynamic plugin loading.

## Decisions (from design review)

| Question | Decision |
|---|---|
| Versioning model | Catalog-only. Plugins stay compiled in. The catalog publishes each plugin's own semver plus the minimum app version each release needs. |
| Source of truth | New public repo `pigontech/inkvoice-plugins`, one `plugin.yaml` per plugin, CI-validated. |
| Distribution | CI builds `catalog.v1.json`, published via GitHub Pages. The site repo vendors a committed snapshot and serves it from `inkvoice.app`. |
| Catalog scope | Every plugin that exists or is planned, including ones a given install cannot run. |
| Vote counts | Not in the catalog. Live mutable data, served separately (spec E). |
| Dynamic install | Explicitly out of scope. Schema is `v1` and may be extended additively later. |

## Why a separate repo

All four plugins are first-party today, so a separate repo buys no immediate
decoupling. It is chosen for two reasons that outlast that:

- The catalog describes plugins across a **public** repo and a **private** one.
  It cannot live in either without either leaking cloud detail into OSS or
  making OSS depend on a private repo.
- A public plugins repo is the natural place for outside contributions
  (new entries, corrections, translations) and for the demand-signal
  discussions, without opening either product repo to that traffic.

The cost is a third deploy target. That is mitigated by the snapshot model
below, which removes any runtime or build-time dependency on GitHub.

## Repository layout

```
pigontech/inkvoice-plugins/
  schema/plugin.schema.json      # JSON Schema (draft 2020-12) for one entry
  schema/catalog.schema.json     # JSON Schema for the built catalog
  plugins/
    time-tracker/plugin.yaml
    time-tracker/screenshots/*.png
    peppol/plugin.yaml
    france/plugin.yaml
    ...
  scripts/build.ts               # plugin.yaml[] -> catalog.v1.json
  scripts/validate.ts            # schema + cross-field validation
  .github/workflows/ci.yml       # validate on PR, build + publish on main
  README.md                      # how to add or amend an entry
```

## Entry format

One `plugin.yaml` per plugin. Authored by hand, validated in CI.

```yaml
id: time-tracker                # stable, matches registerBackendPlugin id
name: Time Tracker
tagline: Track billable hours and turn them into invoices.
description: |
  Markdown. Rendered on the website detail page and in the app's plugin
  detail view. Keep to a few short paragraphs.
category: productivity          # billing|compliance|productivity|integrations|reporting
status: available               # available | planned
availability: both              # oss | cloud | both
requires_plan: null             # null | pro | business
icon: Clock                     # lucide-react export name
docs: https://github.com/pigontech/inkvoice/blob/main/docs/features/plugins.md
source: https://github.com/pigontech/inkvoice/tree/main/packages/backend/src/plugins/time-tracker
screenshots:
  - { file: screenshots/timer.png, alt: Live timer running against a project }
versions:
  - version: "1.1.0"
    min_app: "0.3.0"
    released: "2026-09-15"
    changelog: Live timer and per-project billable rates.
  - version: "1.0.0"
    min_app: "0.2.0"
    released: "2026-06-08"
```

### Field rules

| Field | Rule |
|---|---|
| `id` | `^[a-z][a-z0-9-]*$`, unique across the catalog, immutable once published. |
| `category` | Closed enum. Adding a value is a schema change plus a translation key in both consumers. |
| `status` | `planned` entries MUST omit `versions` and MUST NOT be registered in any app build. |
| `availability` | `oss` means the OSS app ships it; `cloud` means only the overlay does; `both` means both. |
| `requires_plan` | Only meaningful when `availability` is `cloud` or `both`. Null for OSS-only plugins. |
| `icon` | Must be an export of the `lucide-react` version both consumers depend on. Validated against a generated allowlist. |
| `versions` | Descending by version. `version` and `min_app` are strict semver `MAJOR.MINOR.PATCH`. First entry is the latest. |

### Cross-field validation (in `scripts/validate.ts`)

Schema validation alone is not enough. CI additionally asserts:

1. `status: planned` implies no `versions`, no `source`.
2. `status: available` implies at least one version.
3. `versions` is strictly descending and contains no duplicate versions.
4. `min_app` never decreases as `version` increases.
5. Every `icon` exists in the pinned lucide allowlist.
6. Every `screenshots[].file` exists on disk and has non-empty `alt`.
7. Every `id` is unique.
8. No `id` is in the reserved set `["catalog"]`. Spec B mounts catalog routes
   at `/api/v1/plugins/catalog`, which a plugin of that id would shadow. The
   OSS registry enforces the same list at registration; this rule stops a bad
   entry reaching an install in the first place.

A failure here is a CI failure, not a warning. A malformed catalog reaches two
production consumers.

## Built artifact

`scripts/build.ts` resolves each entry into the shape consumers actually want,
so neither the app nor the site has to understand the `versions` array.

```json
{
  "schema": 1,
  "generated_at": "2026-08-31T09:00:00Z",
  "plugins": [
    {
      "id": "time-tracker",
      "name": "Time Tracker",
      "tagline": "Track billable hours and turn them into invoices.",
      "description": "...markdown...",
      "category": "productivity",
      "status": "available",
      "availability": "both",
      "requires_plan": null,
      "icon": "Clock",
      "docs": "https://...",
      "source": "https://...",
      "screenshots": [{ "url": "https://.../timer.png", "alt": "..." }],
      "latest": {
        "version": "1.1.0",
        "min_app": "0.3.0",
        "released": "2026-09-15",
        "changelog": "Live timer and per-project billable rates."
      },
      "versions": [ /* full history, for the website changelog */ ]
    }
  ]
}
```

`screenshots[].file` becomes an absolute `url` at build time so consumers never
have to resolve relative paths against a repo they may not know about.

Published to `https://pigontech.github.io/inkvoice-plugins/catalog.v1.json` on
every push to `main`.

## Versioning the schema itself

The filename carries the version: `catalog.v1.json`. Rules:

- **Additive changes** (new optional field, new enum value) stay on `v1`.
  Consumers must ignore unknown fields.
- **Breaking changes** publish `catalog.v2.json` alongside `v1`, and `v1`
  keeps being built for at least one full OSS release cycle. Self-hosted
  installs upgrade on their own schedule and must not be broken by a schema
  change they did not opt into.

Both consumers check `schema === 1` and fall back to their bundled snapshot on
mismatch rather than rendering a partially-understood payload.

## How consumers use it

Neither consumer fetches GitHub at runtime.

- **Website (spec E)** runs `bun run sync:plugins`, which fetches
  `catalog.v1.json` and writes it to `content/plugins/catalog.v1.json`. That
  file is **committed**. The site build reads only the local copy, so a GitHub
  outage cannot break a marketing deploy and every catalog change is a
  reviewable diff. The site then serves it at
  `https://inkvoice.app/plugins/catalog.v1.json`.
- **App (spec B)** fetches the site-served URL server-side, on a TTL, with a
  bundled snapshot fallback. It never talks to GitHub.

This gives one publish path and one CDN-served URL, and keeps GitHub off the
critical path of both products.

## Plugin version declaration (consumer-side requirement)

The catalog states what the newest release of a plugin is. For "update
available" to mean anything, the app must state what it actually ships.
`BackendPlugin` therefore gains a required `version: string` field
(strict semver), specified in full in spec B.

CI in this repo cannot verify that, but the OSS release checklist gains a step:
when a plugin's shipped `version` changes, add the matching entry here.

## Seeding

Four entries at launch, reflecting reality:

| id | status | availability | requires_plan | version |
|---|---|---|---|---|
| `time-tracker` | available | both | null | 1.0.0 (min_app 0.2.0) |
| `peppol` | available | cloud | pro | 1.0.0 (min_app 0.2.0) |
| `france` | available | cloud | pro | 1.0.0 (min_app 0.2.0) |

Versions and plan values are transcribed from what the code actually registers
today, not aspirationally. `requires_plan` for `peppol` and `france` must match
the `feature` each declares in its `registerBackendPlugin` call.

Additionally, **at least one `status: planned` entry ships at launch**, so the
demand-voting path in spec E is exercised by real content rather than by a
fixture. Which plugin that is comes from the Notion product roadmap at
implementation time; the requirement is one planned entry, not a particular one.
Its `plugin.yaml` carries `id`, `name`, `tagline`, `description`, `category`
and `availability`, and by rule 1 no `versions` and no `source`.

## Testing

`bun test` in the plugins repo covers `scripts/validate.ts` and
`scripts/build.ts` against fixtures:

- A valid entry passes and builds to the expected resolved shape.
- Each of the eight cross-field rules fails on a fixture that violates it.
- A `planned` entry builds with `latest: null`.
- Relative screenshot paths resolve to absolute URLs.
- The built artifact validates against `catalog.schema.json`.

CI runs validate plus build on every PR, so a bad entry can never reach `main`.

## Out of scope

- Dynamic or third-party plugin installation. Plugins remain compiled in.
- Plugin artifact hosting, signing or integrity hashes.
- Vote counts and any mutable state (spec E).
- Localised plugin names and descriptions. The catalog is English-only in v1;
  the app already translates the framework chrome around it. Revisit once a
  non-English plugin page has demonstrated demand.
