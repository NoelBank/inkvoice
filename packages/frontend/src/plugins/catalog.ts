// Pure view logic for the Plugins tab. No React, no network, no component
// imports, so bun can exercise every branch headless. The types mirror the
// backend's merged payload (packages/backend/src/plugins/merge.ts and
// catalog.service.ts), which is the shape of record.

export type BlockedReason =
  | null
  | "planned"
  | "cloud_only"
  | "requires_feature"
  | "requires_app_upgrade"
  | "not_in_this_build";

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

/** Mirrors the backend's CatalogErrorCode. Coarse on purpose: the backend
 *  refuses to hand the browser the underlying network error, because the
 *  catalog URL is configurable and a verbatim message would let this tab report
 *  which internal hosts and ports answer. */
export type CatalogErrorCode =
  | "blocked"
  | "unreachable"
  | "http_error"
  | "too_large"
  | "invalid_json"
  | "invalid_schema";

export interface CatalogProvenance {
  source: "remote" | "cache" | "snapshot";
  syncedAt: string | null;
  error: CatalogErrorCode | null;
  egressEnabled: boolean;
  /** True on a hosted deployment, where the reader is a customer rather than
   *  the operator. Suppresses every affordance that assumes the two are the
   *  same person: upgrading the app, and turning catalog egress off. */
  managed?: boolean;
  /** Host of the configured catalog source, null when egress is off. */
  host?: string | null;
  /** When the catalog was built upstream. Distinct from syncedAt, which is only
   *  when THIS install last fetched: a fresh fetch of a stale catalog is not
   *  fresh data, and reporting only syncedAt hid that entirely. */
  publishedAt?: string | null;
  /** The published default, so the tab can switch egress back on. */
  defaultUrl?: string;
}

/** Mirrors the backend's VoteOutcome. `already_voted` is its own state because
 *  votes are proxied: the identity that already voted may be this user on
 *  another device, and reporting it as a fresh success would be a lie. */
export interface VoteOutcome {
  count: number | null;
  alreadyVoted: boolean;
  status: "recorded" | "already_voted" | "off" | "rejected" | "failed";
}

export function voteToastKey(status: VoteOutcome["status"]): string {
  switch (status) {
    case "recorded":
      return "plugins.vote_recorded";
    case "already_voted":
      return "plugins.vote_already";
    case "rejected":
      return "plugins.vote_rejected";
    default:
      return "plugins.vote_failed";
  }
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
 *  already in memory. Search covers everything the reader can see on the card
 *  and the detail page, description included: searching for a word visible on
 *  screen and getting "no matches" is the worst possible answer. */
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
      const hay = `${p.name}\n${p.tagline}\n${p.category}\n${p.description}`.toLowerCase();
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
  /** Serving cached data that could not be refreshed. Distinct from "failed"
   *  (which falls all the way back to the bundled snapshot) and from "synced",
   *  because an install whose catalog has been unreachable for weeks used to
   *  render as a plain "Synced 20 days ago" with the error dropped entirely. */
  | { kind: "stale"; ageMinutes: number | null; reason: CatalogErrorCode | null }
  | { kind: "failed"; reason: CatalogErrorCode | null }
  | { kind: "off" };

export function footerState(p: CatalogProvenance, now: number): FooterState {
  if (!p.egressEnabled) return { kind: "off" };
  if (p.source === "snapshot") {
    return { kind: "failed", reason: p.error };
  }
  const ageMinutes = minutesSince(p.syncedAt, now);
  if (p.error !== null) return { kind: "stale", ageMinutes, reason: p.error };
  return { kind: "synced", ageMinutes };
}

const ERROR_KEYS: Record<CatalogErrorCode, string> = {
  blocked: "plugins.catalog_error_blocked",
  unreachable: "plugins.catalog_error_unreachable",
  http_error: "plugins.catalog_error_http",
  too_large: "plugins.catalog_error_too_large",
  invalid_json: "plugins.catalog_error_invalid",
  invalid_schema: "plugins.catalog_error_invalid",
};

/** i18n key for a failure code. Falls back to the generic string for a code
 *  a newer backend introduced, so an upgraded server never renders a raw key. */
export function catalogErrorKey(code: CatalogErrorCode | null): string {
  return (code && ERROR_KEYS[code]) || "plugins.catalog_error_unknown";
}

/** i18n key for the reason chip. Null when there is no blocker, so the caller
 *  renders the enable switch instead. On a managed deployment the upgrade
 *  reason becomes a plain "not available", because the reader cannot upgrade
 *  the server and telling them to is worse than saying nothing. */
export function blockedChipKey(reason: BlockedReason, managed = false): string | null {
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
      return managed ? "plugins.chip_unavailable" : "plugins.chip_requires_app_upgrade";
    case "not_in_this_build":
      return "plugins.chip_not_in_build";
  }
}

/** Where the catalog came from, for the provenance line. Null when unknown, so
 *  a footer talking to an older backend says nothing rather than guessing. */
export function catalogOrigin(p: CatalogProvenance): string | null {
  return p.host ?? null;
}

/** Whether the tab may offer an update affordance at all. A hosted customer
 *  cannot act on one, and pointing them at a GitHub release is noise. */
export function canShowUpdates(provenance: CatalogProvenance | null): boolean {
  return provenance?.managed !== true;
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
