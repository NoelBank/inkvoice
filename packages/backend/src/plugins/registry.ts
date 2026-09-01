// Statically compiled-in official plugins. A plugin is one self-contained
// folder that calls registerBackendPlugin() at import time; the barrel
// (./index.ts) side-effect-imports them so the registry is populated before
// runPluginMigrations() and route mounting in app.ts. Overlays register their
// own plugins into this same registry from their bootstrap.

import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

/** A schema migration owned by a plugin, tracked independently of core
 *  migrations in plugin_schema_migrations keyed by (plugin_id, version). */
export interface PluginMigration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export interface BackendPlugin {
  /** Stable id, also the URL segment: /api/v1/plugins/<id>/... */
  id: string;
  /** Strict semver of this plugin's own implementation, independent of the app
   *  version. Compared against the catalog's latest to drive the update badge.
   *  Bump it whenever the plugin's behaviour changes. */
  version: string;
  /** Mounted (auth-gated) under /api/v1/plugins/<id>. */
  routes: Hono;
  /** Tables/columns created for every install regardless of enablement. */
  migrations: PluginMigration[];
  /** Inert in OSS. An overlay may install a policy gate for it (see gate.ts). */
  feature?: string;
  /** On for installs that never explicitly toggled their plugin set. */
  defaultEnabled?: boolean;
}

/** Ids the app mounts its own routes under, so a plugin may never claim them.
 *  A plugin with id "catalog" would shadow /api/v1/plugins/catalog. Mirrored as
 *  a validation rule in the pigontech/inkvoice-plugins catalog repo. */
export const RESERVED_PLUGIN_IDS = ["catalog"] as const;

const PLUGINS: BackendPlugin[] = [];

export function registerBackendPlugin(plugin: BackendPlugin): void {
  if ((RESERVED_PLUGIN_IDS as readonly string[]).includes(plugin.id)) {
    throw new Error(`Plugin id "${plugin.id}" is reserved`);
  }
  // Idempotent re-registration (HMR / repeated imports) replaces by id.
  const idx = PLUGINS.findIndex((p) => p.id === plugin.id);
  if (idx >= 0) PLUGINS.splice(idx, 1);
  PLUGINS.push(plugin);
}

export function getBackendPlugins(): BackendPlugin[] {
  return PLUGINS;
}

export function getBackendPlugin(id: string): BackendPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}
