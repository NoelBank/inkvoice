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
  | "requires_app_upgrade"
  /** Catalogued, absent from this build, and this app already satisfies the
   *  release's min_app. Telling the reader to upgrade would be provably wrong,
   *  so say what is true: the build does not carry it. */
  | "not_in_this_build";

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
  appVersion: string,
): BlockedReason {
  // Order matters. Planned wins over everything: it does not exist yet.
  if (entry?.status === "planned") return "planned";

  if (!local) {
    // The catalog knows it, this binary does not ship it.
    if (entry?.availability === "cloud") return "cloud_only";
    // "Upgrade" is only honest advice when there is a version to move to. If
    // this app already meets the release's min_app, upgrading provably cannot
    // deliver the plugin, and the mismatch is a packaging or catalog fault
    // rather than something the reader can fix.
    const minApp = entry?.latest?.min_app ?? null;
    if (minApp !== null && gte(appVersion, minApp)) return "not_in_this_build";
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

    // An update is only offered when it is reachable: the catalog names a newer
    // plugin release AND an app version that carries it which this install does
    // not yet have. Without the second condition the tab announced updates that
    // upgrading could not deliver, with a releases link and no instruction.
    const appBelowMinApp = minApp !== null && !gte(appVersion, minApp);
    const updateAvailable =
      installedVersion !== null &&
      latestVersion !== null &&
      gt(latestVersion, installedVersion) &&
      appBelowMinApp;

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
      updateRequiresApp: appBelowMinApp ? minApp : null,
      enabled: local?.enabled ?? false,
      blockedReason: blockedReasonFor(entry, local, isEntitled, appVersion),
      votes: votes[id] ?? 0,
    };
  });
}
