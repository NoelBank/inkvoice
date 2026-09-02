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
import { SafeFetchError, type SafeFetchErrorCode, safeFetchJson } from "../utils/safe-fetch";
import snapshot from "./catalog-snapshot.json";

export const DEFAULT_CATALOG_URL = "https://inkvoice.app/plugins/catalog.v1.json";
export const DEFAULT_VOTES_URL = "https://inkvoice.app/api/plugin-votes";
export const DEFAULT_VOTE_POST_URL = "https://inkvoice.app/api/plugin-vote";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
/** The published catalog is a few KB. The cap exists so a hostile endpoint
 *  cannot stream gigabytes into memory and then into the settings row. */
const MAX_CATALOG_BYTES = 1024 * 1024;

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

/** Coarse, non-identifying failure reason. Deliberately not the underlying
 *  message: the catalog URL is operator-configurable and the result is shown to
 *  any authenticated user, so a verbatim "connect ECONNREFUSED 10.0.0.5:6379"
 *  would turn the Plugins tab into an internal network scanner. The detail is
 *  logged instead. */
export type CatalogErrorCode = SafeFetchErrorCode | "invalid_schema";

export interface CatalogResult {
  catalog: Catalog;
  source: "remote" | "cache" | "snapshot";
  /** ISO timestamp of the last successful remote fetch, null if never. */
  syncedAt: string | null;
  /** Why the remote was not used this time, null when it was. */
  error: CatalogErrorCode | null;
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

/** The URL is settings-controlled, so every fetch goes through the SSRF-aware
 *  helper: private ranges refused, redirects re-validated, body size capped. */
async function fetchJson(url: string): Promise<unknown> {
  return safeFetchJson(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_CATALOG_BYTES });
}

/** Map any thrown value onto the coarse code the client is allowed to see,
 *  logging the real reason for the operator. */
function errorCode(err: unknown, context: Record<string, unknown>): CatalogErrorCode {
  const code: CatalogErrorCode = err instanceof SafeFetchError ? err.code : "unreachable";
  logger.warn({ ...context, code, err: (err as Error).message }, "Plugin catalog request failed");
  return code;
}

function snapshotResult(error: CatalogErrorCode | null, syncedAt: string | null): CatalogResult {
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

  let code: CatalogErrorCode;
  try {
    const payload = await fetchJson(url);
    if (isCatalog(payload)) {
      const syncedAt = new Date().toISOString();
      updateSettings({
        [KEY_CACHE]: JSON.stringify(payload),
        [KEY_SYNCED_AT]: syncedAt,
      });
      return { catalog: payload, source: "remote", syncedAt, error: null };
    }
    logger.warn({ url }, "Plugin catalog response had an unexpected shape");
    code = "invalid_schema";
  } catch (err) {
    code = errorCode(err, { url });
  }

  if (cached) {
    return { catalog: cached.catalog, source: "cache", syncedAt: cached.syncedAt, error: code };
  }
  return snapshotResult(code, null);
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
    const payload = await safeFetchJson(DEFAULT_VOTES_URL, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_CATALOG_BYTES,
    });
    if (typeof payload !== "object" || payload === null) return {};
    const counts = payload as Record<string, number>;
    updateSettings({ [KEY_VOTES]: JSON.stringify(counts) });
    return counts;
  } catch (err) {
    errorCode(err, { url: DEFAULT_VOTES_URL });
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
    const data = (await safeFetchJson(DEFAULT_VOTE_POST_URL, {
      method: "POST",
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })) as { count?: number };
    return typeof data.count === "number" ? data.count : null;
  } catch (err) {
    errorCode(err, { id, url: DEFAULT_VOTE_POST_URL });
    return null;
  }
}
