import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { listBackups, pruneBackups, runBackup, shouldRunBackups } from "../services/backup.service";
import { getEnv, resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-auto-backup.db";
const BACKUP_DIR = "./data/test-auto-backup-snapshots";

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}

beforeAll(async () => {
  setEnv({
    DATABASE_PATH: TEST_DB,
    ADMIN_USER: "admin",
    ADMIN_PASS: "backupschedulepass",
    JWT_SECRET: "test-secret-key-that-is-at-least-32-chars-long",
    BACKUP_DIR,
    BACKUP_ENABLED: undefined,
    BACKUP_KEEP: undefined,
    DEMO_MODE: undefined,
  });

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEST_DB + suffix);
    } catch {}
  }
  rmSync(BACKUP_DIR, { recursive: true, force: true });

  initDatabase();
  runMigrations();
  await seed();
});

beforeEach(() => {
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  setEnv({ BACKUP_DIR, BACKUP_KEEP: undefined, BACKUP_ENABLED: undefined, DEMO_MODE: undefined });
});

afterAll(() => {
  closeDatabase();
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("configuration", () => {
  test("backups are on by default and default to a dir next to the database", () => {
    setEnv({ BACKUP_DIR: undefined, DATABASE_PATH: "/srv/app/data/invoice.db" });
    const env = getEnv();
    expect(env.BACKUP_ENABLED).toBe(true);
    expect(env.BACKUP_DIR).toBe(join("/srv/app/data", "backups"));
    expect(env.BACKUP_KEEP).toBe(7);
    setEnv({ DATABASE_PATH: TEST_DB, BACKUP_DIR });
  });

  test("BACKUP_ENABLED=false turns the job off", () => {
    setEnv({ BACKUP_ENABLED: "false" });
    expect(shouldRunBackups()).toBe(false);
  });

  test("a nonsensical BACKUP_KEEP falls back to the default instead of wiping history", () => {
    for (const bad of ["0", "-3", "not-a-number"]) {
      setEnv({ BACKUP_KEEP: bad });
      expect(getEnv().BACKUP_KEEP).toBe(7);
    }
  });
});

describe("runBackup", () => {
  test("writes a snapshot that is a readable copy of the data", () => {
    getDb().run("INSERT INTO customers (id, name, email) VALUES (?, ?, ?)", [
      "backup-customer",
      "Snapshot Ltd",
      "snap@example.com",
    ]);

    const result = runBackup();
    expect(result).not.toBeNull();
    expect(existsSync(result!.path)).toBe(true);
    expect(result!.bytes).toBeGreaterThan(0);

    // The point of a backup is that it can be opened on its own.
    const restored = new Database(result!.path, { readonly: true });
    const row = restored.query("SELECT name FROM customers WHERE id = ?").get("backup-customer") as
      | { name: string }
      | undefined;
    restored.close();
    expect(row?.name).toBe("Snapshot Ltd");
  });

  test("consecutive runs do not collide", () => {
    expect(runBackup()).not.toBeNull();
    expect(runBackup()).not.toBeNull();
    expect(listBackups(BACKUP_DIR).length).toBe(2);
  });

  test("creates the backup directory if it is missing", () => {
    const nested = join(BACKUP_DIR, "deep", "nested");
    setEnv({ BACKUP_DIR: nested });
    expect(runBackup()).not.toBeNull();
    expect(listBackups(nested)).toHaveLength(1);
  });

  test("a snapshot taken later reflects newer data", () => {
    const before = runBackup();
    getDb().run("INSERT INTO customers (id, name) VALUES (?, ?)", ["later-customer", "Later Ltd"]);
    const after = runBackup();

    const openCount = (path: string) => {
      const db = new Database(path, { readonly: true });
      const row = db
        .query("SELECT COUNT(*) as cnt FROM customers WHERE id = ?")
        .get("later-customer") as { cnt: number };
      db.close();
      return row.cnt;
    };

    expect(openCount(before!.path)).toBe(0);
    expect(openCount(after!.path)).toBe(1);
  });
});

describe("pruning", () => {
  function seedFakeBackups(count: number): void {
    mkdirSync(BACKUP_DIR, { recursive: true });
    for (let i = 1; i <= count; i++) {
      writeFileSync(join(BACKUP_DIR, `inkvoice-2026-01-${String(i).padStart(2, "0")}.db`), "x");
    }
  }

  test("keeps the newest N and deletes the rest", () => {
    seedFakeBackups(10);
    const removed = pruneBackups(BACKUP_DIR, 3);
    expect(removed).toHaveLength(7);

    const left = listBackups(BACKUP_DIR).map((f) => f.name);
    expect(left).toEqual([
      "inkvoice-2026-01-10.db",
      "inkvoice-2026-01-09.db",
      "inkvoice-2026-01-08.db",
    ]);
  });

  test("does nothing when there are fewer files than the limit", () => {
    seedFakeBackups(2);
    expect(pruneBackups(BACKUP_DIR, 7)).toHaveLength(0);
    expect(listBackups(BACKUP_DIR)).toHaveLength(2);
  });

  test("ignores unrelated files in the directory", () => {
    seedFakeBackups(3);
    writeFileSync(join(BACKUP_DIR, "notes.txt"), "keep me");
    pruneBackups(BACKUP_DIR, 1);
    expect(existsSync(join(BACKUP_DIR, "notes.txt"))).toBe(true);
    expect(listBackups(BACKUP_DIR)).toHaveLength(1);
  });

  test("runBackup enforces BACKUP_KEEP", () => {
    setEnv({ BACKUP_KEEP: "2" });
    runBackup();
    runBackup();
    runBackup();
    expect(listBackups(BACKUP_DIR)).toHaveLength(2);
  });

  test("listBackups on a missing directory returns empty rather than throwing", () => {
    expect(listBackups(join(BACKUP_DIR, "does-not-exist"))).toEqual([]);
  });
});
