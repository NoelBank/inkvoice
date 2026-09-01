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
