import type { PluginMigration } from "../registry";

// Time Tracker schema. Tracked in plugin_schema_migrations under
// plugin_id = "time-tracker", evolving independently of core migrations.
// Byte-identical to the version that shipped in Inkvoice Cloud so existing
// tenant databases continue without a data migration.
export const timeTrackerMigrations: PluginMigration[] = [
  {
    version: 1,
    name: "time_tracker_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tt_projects (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          name TEXT NOT NULL,
          customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
          default_rate REAL,
          billable INTEGER NOT NULL DEFAULT 1,
          color TEXT,
          is_archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tt_time_entries (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          project_id TEXT NOT NULL REFERENCES tt_projects(id) ON DELETE CASCADE,
          description TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_seconds INTEGER,
          rate REAL,
          billable INTEGER NOT NULL DEFAULT 1,
          is_billed INTEGER NOT NULL DEFAULT 0,
          invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
          user_id TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_tt_entries_project ON tt_time_entries(project_id);
        CREATE INDEX IF NOT EXISTS idx_tt_entries_user ON tt_time_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_tt_entries_billed ON tt_time_entries(is_billed);
        CREATE INDEX IF NOT EXISTS idx_tt_projects_customer ON tt_projects(customer_id);
      `);
    },
  },
];
