import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { checkVatId } from "../services/vat-validation.service";
import { resetEnvCache } from "../utils/env";
import { isEuVatCountry, normalizeVatId, parseVatId } from "../utils/vat-id";

const TEST_DB = "./data/test-vat-validation.db";
const CUSTOMER_ID = "vat-customer";

let app: Hono;
let token: string;
let server: ReturnType<typeof Bun.serve>;

/** Next reply the stubbed VIES endpoint should give. */
let viesHandler: (req: Request) => Response | Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "vattestpass12345";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }

  // Stand in for VIES so the suite never touches the real registry.
  server = Bun.serve({ port: 0, fetch: (req) => viesHandler(req) });
  process.env.VIES_BASE_URL = `http://localhost:${server.port}`;

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "vattestpass12345" }),
  });
  token = ((await res.json()) as any).data.token;
});

beforeEach(() => {
  getDb().run("DELETE FROM customers WHERE id = ?", [CUSTOMER_ID]);
  getDb().run("INSERT INTO customers (id, name, tax_id) VALUES (?, ?, ?)", [
    CUSTOMER_ID,
    "Beispiel GmbH",
    "DE123456789",
  ]);
});

afterAll(() => {
  server.stop(true);
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

function validateRequest() {
  return app.request(`/api/v1/customers/${CUSTOMER_ID}/validate-vat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function customerRow() {
  return getDb()
    .query("SELECT vat_valid, vat_checked_at, vat_check_name FROM customers WHERE id = ?")
    .get(CUSTOMER_ID) as {
    vat_valid: number | null;
    vat_checked_at: string | null;
    vat_check_name: string | null;
  };
}

describe("parseVatId", () => {
  test("normalizes spacing, punctuation and case", () => {
    expect(normalizeVatId(" de 123.456-789 ")).toBe("DE123456789");
  });

  test("accepts well-formed numbers across member states", () => {
    for (const id of [
      "DE123456789",
      "ATU12345678",
      "NL123456789B01",
      "FRAB123456789",
      "IT12345678901",
    ]) {
      expect(parseVatId(id).syntaxValid).toBe(true);
    }
  });

  test("rejects wrong lengths and unknown countries", () => {
    for (const id of ["DE12345678", "DE1234567890", "ZZ123456789", "DE", "123456789"]) {
      expect(parseVatId(id).syntaxValid).toBe(false);
    }
  });

  test("splits country code from number", () => {
    const parsed = parseVatId("de123456789");
    expect(parsed.countryCode).toBe("DE");
    expect(parsed.number).toBe("123456789");
  });

  test("knows which country codes VIES covers", () => {
    expect(isEuVatCountry("de")).toBe(true);
    expect(isEuVatCountry("XI")).toBe(true);
    expect(isEuVatCountry("US")).toBe(false);
  });
});

describe("checkVatId", () => {
  test("a malformed id is answered locally without calling VIES", async () => {
    let called = false;
    viesHandler = () => {
      called = true;
      return Response.json({ isValid: true });
    };

    const result = await checkVatId("NOPE");
    expect(result.status).toBe("unsupported");
    expect(called).toBe(false);
  });

  test("asks the right VIES path", async () => {
    let seenPath = "";
    viesHandler = (req) => {
      seenPath = new URL(req.url).pathname;
      return Response.json({ isValid: true, name: "Beispiel GmbH", address: "Berlin" });
    };

    await checkVatId("DE 123 456 789");
    expect(seenPath).toBe("/ms/DE/vat/123456789");
  });

  test("maps a valid response, dropping the '---' placeholder", async () => {
    viesHandler = () => Response.json({ isValid: true, name: "Beispiel GmbH", address: "---" });

    const result = await checkVatId("DE123456789");
    expect(result.status).toBe("valid");
    expect(result.name).toBe("Beispiel GmbH");
    expect(result.address).toBeNull();
    expect(result.checked_at).toBeString();
  });

  test("maps an invalid response", async () => {
    viesHandler = () => Response.json({ isValid: false, name: null, address: null });
    expect((await checkVatId("DE123456789")).status).toBe("invalid");
  });

  test("a member-state outage reports unavailable, not invalid", async () => {
    viesHandler = () => Response.json({ isValid: false, userError: "MS_UNAVAILABLE" });
    const result = await checkVatId("DE123456789");
    expect(result.status).toBe("unavailable");
    expect(result.detail).toBe("MS_UNAVAILABLE");
  });

  test("an HTTP error reports unavailable", async () => {
    viesHandler = () => new Response("boom", { status: 503 });
    const result = await checkVatId("DE123456789");
    expect(result.status).toBe("unavailable");
    expect(result.detail).toBe("http_503");
  });

  test("an unparseable body reports unavailable", async () => {
    viesHandler = () => new Response("<html>not json</html>", { status: 200 });
    expect((await checkVatId("DE123456789")).status).toBe("unavailable");
  });

  test("an unreachable registry reports unavailable instead of throwing", async () => {
    const previous = process.env.VIES_BASE_URL;
    // Port 1 is reserved and refuses instantly.
    process.env.VIES_BASE_URL = "http://127.0.0.1:1";
    const result = await checkVatId("DE123456789");
    process.env.VIES_BASE_URL = previous;

    expect(result.status).toBe("unavailable");
    expect(result.detail).toBe("network");
  });
});

describe("POST /customers/:id/validate-vat", () => {
  test("stores a valid verdict with the registered name", async () => {
    viesHandler = () => Response.json({ isValid: true, name: "Beispiel GmbH", address: "Berlin" });

    const res = await validateRequest();
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.status).toBe("valid");

    const row = customerRow();
    expect(row.vat_valid).toBe(1);
    expect(row.vat_check_name).toBe("Beispiel GmbH");
    expect(row.vat_checked_at).toBeString();
  });

  test("stores an invalid verdict", async () => {
    viesHandler = () => Response.json({ isValid: false });
    await validateRequest();
    expect(customerRow().vat_valid).toBe(0);
  });

  test("an outage leaves the previous verdict intact", async () => {
    viesHandler = () => Response.json({ isValid: true, name: "Beispiel GmbH" });
    await validateRequest();
    expect(customerRow().vat_valid).toBe(1);

    viesHandler = () => Response.json({ isValid: false, userError: "MS_MAX_CONCURRENT_REQ" });
    const res = await validateRequest();
    expect(((await res.json()) as any).data.status).toBe("unavailable");

    const row = customerRow();
    expect(row.vat_valid).toBe(1);
    expect(row.vat_check_name).toBe("Beispiel GmbH");
  });

  test("a customer without a VAT ID reports unsupported and records nothing", async () => {
    getDb().run("UPDATE customers SET tax_id = '' WHERE id = ?", [CUSTOMER_ID]);
    const res = await validateRequest();
    expect(((await res.json()) as any).data.status).toBe("unsupported");
    expect(customerRow().vat_valid).toBeNull();
  });

  test("an unknown customer is a 404", async () => {
    const res = await app.request("/api/v1/customers/does-not-exist/validate-vat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test("requires authentication", async () => {
    const res = await app.request(`/api/v1/customers/${CUSTOMER_ID}/validate-vat`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
