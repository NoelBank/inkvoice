import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { dbStorage } from "../database/connection";
import {
  LATEST_MIGRATION_VERSION,
  runMigrations,
  setMigrationBackupsEnabled,
} from "../database/migrations";

const TEST_DB = "./data/test-migrations.db";

function freshDb(): Database {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-wal`);
  } catch {}
  try {
    unlinkSync(`${TEST_DB}-shm`);
  } catch {}
  const db = new Database(TEST_DB);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function runWith(db: Database, fn: () => void): void {
  // Disable backup writes during tests — backupDatabase reads
  // process.env.DATABASE_PATH which is unrelated to TEST_DB.
  setMigrationBackupsEnabled(false);
  try {
    dbStorage.run({ db, tenantId: "test-tenant" }, fn);
  } finally {
    setMigrationBackupsEnabled(true);
  }
}

describe("schema migration runner", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
    try {
      unlinkSync(`${TEST_DB}-wal`);
    } catch {}
    try {
      unlinkSync(`${TEST_DB}-shm`);
    } catch {}
  });

  test("fresh DB applies every migration in order", () => {
    runWith(db, () => runMigrations());

    const rows = db.query("SELECT version, name FROM schema_migrations ORDER BY version").all() as {
      version: number;
      name: string;
    }[];
    expect(rows.length).toBe(LATEST_MIGRATION_VERSION);
    expect(rows[0].version).toBe(1);
    expect(rows[rows.length - 1].version).toBe(LATEST_MIGRATION_VERSION);

    // Versions are strictly increasing.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].version).toBe(rows[i - 1].version + 1);
    }

    // applied_at is real (not "backfilled").
    const samples = db.query("SELECT applied_at FROM schema_migrations LIMIT 1").all() as {
      applied_at: string;
    }[];
    expect(samples[0].applied_at).not.toBe("backfilled");
  });

  test("re-running migrations is a no-op", () => {
    runWith(db, () => runMigrations());
    const before = db.query("SELECT applied_at FROM schema_migrations WHERE version = 1").get() as {
      applied_at: string;
    };

    runWith(db, () => runMigrations());
    const after = db.query("SELECT applied_at FROM schema_migrations WHERE version = 1").get() as {
      applied_at: string;
    };

    expect(before.applied_at).toBe(after.applied_at);
    const count = db.query("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number };
    expect(count.c).toBe(LATEST_MIGRATION_VERSION);
  });

  test("creates expected core tables", () => {
    runWith(db, () => runMigrations());

    const expected = [
      "settings",
      "customers",
      "tax_definitions",
      "products",
      "templates",
      "invoices",
      "invoice_items",
      "users",
      "user_permissions",
      "recurring_invoices",
      "payments",
      "activity_log",
      "reminder_rules",
      "reminder_log",
      "quotes",
      "quote_items",
      "feedback",
      "invoice_taxes",
      "invoice_item_taxes",
      "product_categories",
      "product_units",
      "portal_tokens",
      "invoice_comments",
      "outgoing_webhooks",
      "webhook_deliveries",
    ];

    for (const name of expected) {
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name) as { name: string } | null;
      expect(row?.name).toBe(name);
    }
  });

  test("pre-versioning DB is backfilled instead of re-running migrations", () => {
    // Simulate an existing DB where migrations ran via the old pragma-based
    // path: customers (and friends) exist, but schema_migrations does not.
    db.exec(`
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO customers (id, name) VALUES ('seed1', 'Pre-existing customer');
    `);

    runWith(db, () => runMigrations());

    const rows = db
      .query("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all() as { version: number; applied_at: string }[];
    expect(rows.length).toBe(LATEST_MIGRATION_VERSION);
    expect(rows.every((r) => r.applied_at === "backfilled")).toBe(true);

    // Pre-existing data is preserved — backfill must not re-run migration #1.
    const cust = db.query("SELECT name FROM customers WHERE id = 'seed1'").get() as {
      name: string;
    } | null;
    expect(cust?.name).toBe("Pre-existing customer");
  });

  test("applies only new migrations on subsequent runs", () => {
    runWith(db, () => runMigrations());

    // Pretend version 10 was the previous tip, then revert one row to simulate
    // what happens if a hypothetical version 11 migration ships.
    db.exec(`DELETE FROM schema_migrations WHERE version = ${LATEST_MIGRATION_VERSION}`);
    const before = db.query("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number };
    expect(before.c).toBe(LATEST_MIGRATION_VERSION - 1);

    runWith(db, () => runMigrations());

    const after = db.query("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number };
    expect(after.c).toBe(LATEST_MIGRATION_VERSION);
  });

  test("version 24 creates the PEPPOL transport tables and inbox columns", () => {
    runWith(db, () => runMigrations());

    const tables = [
      "einvoice_transmissions",
      "einvoice_transmission_attempts",
      "peppol_participants",
      "einvoice_webhook_events",
    ];
    for (const name of tables) {
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name) as { name: string } | null;
      expect(row?.name, name).toBe(name);
    }

    // Column additions land on einvoice_inbox without disturbing existing rows.
    const custCols = db
      .query(
        "SELECT name FROM pragma_table_info('einvoice_inbox') WHERE name LIKE 'source' OR name LIKE 'transport_id' OR name LIKE 'provider_message_id' OR name LIKE 'sender_scheme' OR name LIKE 'sender_id'",
      )
      .all() as { name: string }[];
    expect(custCols.map((c) => c.name).sort()).toEqual([
      "provider_message_id",
      "sender_id",
      "sender_scheme",
      "source",
      "transport_id",
    ]);

    const customerCols = db
      .query("SELECT name FROM pragma_table_info('customers') WHERE name LIKE 'peppol_%'")
      .all() as { name: string }[];
    expect(customerCols.map((c) => c.name).sort()).toEqual([
      "peppol_checked_at",
      "peppol_reachable",
    ]);

    // The partial unique index on provider_message_id exists.
    const idx = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_einvoice_tx_provider_msg'",
      )
      .get() as { name: string } | null;
    expect(idx?.name).toBe("idx_einvoice_tx_provider_msg");
  });

  test("version 24 applies on a database already at version 23", () => {
    // Apply everything except the last migration, then apply the remainder.
    runWith(db, () => runMigrations());
    db.exec(`DELETE FROM schema_migrations WHERE version = ${LATEST_MIGRATION_VERSION}`);

    // Simulate a real v23 tip: drop the v24 tables (as if never created).
    db.exec("DROP TABLE einvoice_webhook_events");
    db.exec("DROP TABLE peppol_participants");
    db.exec("DROP TABLE einvoice_transmission_attempts");
    db.exec("DROP TABLE einvoice_transmissions");

    runWith(db, () => runMigrations());

    const row = db
      .query("SELECT version FROM schema_migrations WHERE version = ?")
      .get(LATEST_MIGRATION_VERSION) as { version: number } | null;
    expect(row?.version).toBe(LATEST_MIGRATION_VERSION);
    const exists = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'einvoice_transmissions'",
      )
      .get() as { name: string } | null;
    expect(exists?.name).toBe("einvoice_transmissions");
  });
});
