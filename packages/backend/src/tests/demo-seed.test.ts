import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed, seedDemoDataIfEmpty } from "../database/seed";
import { getAllSettings, updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-demo-seed.db";

function removeDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
}

/** Re-read the env with DEMO_MODE set as given. */
function setDemoMode(on: boolean): void {
  if (on) process.env.DEMO_MODE = "true";
  else delete process.env.DEMO_MODE;
  resetEnvCache();
}

/** Boot a brand-new database the way the standalone entry point does. */
async function bootFresh(demo: boolean): Promise<void> {
  closeDatabase();
  removeDb();
  setDemoMode(demo);
  initDatabase();
  runMigrations();
  await seed();
}

function counts(): { customers: number; products: number; invoices: number } {
  const db = getDb();
  const rowCount = (table: string) =>
    (db.query(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;
  return {
    customers: rowCount("customers"),
    products: rowCount("products"),
    invoices: rowCount("invoices"),
  };
}

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "demoseedtestpass";
});

afterAll(() => {
  delete process.env.DEMO_MODE;
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  resetEnvCache();
  closeDatabase();
  removeDb();
});

describe("seed() company profile", () => {
  test("demotes renamed legacy built-in units and restores canonical units", async () => {
    await bootFresh(false);
    const db = getDb();
    const piece = db.query("SELECT id FROM product_units WHERE name = 'piece'").get() as {
      id: string;
    };
    db.run("UPDATE product_units SET name = 'Monat' WHERE id = ?", [piece.id]);

    await seed();

    const legacy = db.query("SELECT is_builtin FROM product_units WHERE name = 'Monat'").get() as {
      is_builtin: number;
    };
    expect(legacy.is_builtin).toBe(0);
    expect(db.query("SELECT id FROM product_units WHERE name = 'piece'").get()).toBeTruthy();
    expect(db.query("SELECT id FROM product_units WHERE name = 'month'").get()).toBeTruthy();
  });

  test("leaves the stock placeholder profile alone on a self-hosted install", async () => {
    await bootFresh(false);
    const settings = getAllSettings();
    // An unconfigured install must still get the first-run wizard.
    expect(settings.onboarding_completed).toBeUndefined();
    expect(settings.company_name).toBe("My Company");
    expect(settings.company_address).toBe("");
    expect(settings.company_country).toBe("");
  });

  test("marks onboarding complete and fills in the demo company when DEMO_MODE is on", async () => {
    await bootFresh(true);
    const settings = getAllSettings();
    // Without this the demo's first screen is the setup wizard.
    expect(settings.onboarding_completed).toBe("true");
    expect(settings.company_name).not.toBe("My Company");
    for (const key of [
      "company_name",
      "company_email",
      "company_phone",
      "company_address",
      "company_tax_id",
    ]) {
      expect(settings[key]).toBeTruthy();
    }
    expect(settings.company_country).toBe("US");
    // The demo invoices are USD, so the profile must not drift from them.
    expect(settings.currency).toBe("USD");
    expect(settings.base_currency).toBe("USD");
    expect(settings.locale).toBe("en-US");
  });

  test("keeps the generic 'No Tax' definition for the US demo company", async () => {
    await bootFresh(true);
    const rows = getDb().query("SELECT name FROM tax_definitions").all() as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("No Tax");
  });

  test("restores the demo profile on the next boot after a visitor edits it", async () => {
    await bootFresh(true);
    updateSettings({ company_name: "Visitor Renamed Co", onboarding_completed: "false" });
    expect(getAllSettings().company_name).toBe("Visitor Renamed Co");

    await seed(); // restart, same database
    const settings = getAllSettings();
    expect(settings.company_name).toBe("Northwind Studio");
    expect(settings.onboarding_completed).toBe("true");
  });

  test("upgrades a database first seeded before DEMO_MODE was switched on", async () => {
    await bootFresh(false);
    expect(getAllSettings().company_name).toBe("My Company");

    setDemoMode(true);
    await seed();
    const settings = getAllSettings();
    expect(settings.onboarding_completed).toBe("true");
    expect(settings.company_name).toBe("Northwind Studio");
  });
});

describe("seedDemoDataIfEmpty()", () => {
  test("populates an empty demo database at boot", async () => {
    await bootFresh(true);
    expect(counts()).toEqual({ customers: 0, products: 0, invoices: 0 });

    expect(seedDemoDataIfEmpty()).toBe(true);
    const after = counts();
    expect(after.customers).toBe(5);
    expect(after.products).toBe(8);
    // 12 months of history so the revenue chart has something to draw.
    expect(after.invoices).toBe(25);
  });

  test("does nothing on a second boot so a restart cannot duplicate the dataset", async () => {
    await bootFresh(true);
    expect(seedDemoDataIfEmpty()).toBe(true);
    const after = counts();

    expect(seedDemoDataIfEmpty()).toBe(false);
    expect(counts()).toEqual(after);
  });

  test("does nothing when only customers exist", async () => {
    await bootFresh(true);
    getDb().run("INSERT INTO customers (id, name) VALUES ('cust-1', 'Real Customer')");

    expect(seedDemoDataIfEmpty()).toBe(false);
    expect(counts()).toEqual({ customers: 1, products: 0, invoices: 0 });
  });

  test("does nothing on a self-hosted install, even with an empty database", async () => {
    await bootFresh(false);
    expect(seedDemoDataIfEmpty()).toBe(false);
    expect(counts()).toEqual({ customers: 0, products: 0, invoices: 0 });
  });
});
