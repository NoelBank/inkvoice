// Applies every registered plugin's pending migrations to the current DB.
// Tracked in plugin_schema_migrations keyed by (plugin_id, version), evolving
// independently of core migrations. Tables are created for every install
// regardless of enablement, which keeps toggling instant. Must run after core
// runMigrations(). Safe to call repeatedly; only pending versions execute.

import type { Database } from "bun:sqlite";
import { getDb } from "../database/connection";
import { logger } from "../utils/logger";
import { getBackendPlugins } from "./registry";

export function runPluginMigrations(db?: Database): void {
  const plugins = getBackendPlugins();
  if (plugins.length === 0) return;

  const target = db ?? getDb();
  target.exec(`
    CREATE TABLE IF NOT EXISTS plugin_schema_migrations (
      plugin_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plugin_id, version)
    );
  `);

  for (const plugin of plugins) {
    const row = target
      .query("SELECT MAX(version) as v FROM plugin_schema_migrations WHERE plugin_id = ?")
      .get(plugin.id) as { v: number | null };
    const currentVersion = row.v ?? 0;
    const pending = plugin.migrations
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      target.transaction(() => {
        migration.up(target);
        target.run(
          "INSERT INTO plugin_schema_migrations (plugin_id, version, name) VALUES (?, ?, ?)",
          [plugin.id, migration.version, migration.name],
        );
      })();
      logger.info(
        { plugin: plugin.id, version: migration.version, name: migration.name },
        "Applied plugin migration",
      );
    }
  }
}
