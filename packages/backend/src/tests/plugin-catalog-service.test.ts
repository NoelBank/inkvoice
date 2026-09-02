import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { getCatalog, getVotes, postVote } from "../plugins/catalog.service";
import { getSetting, updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";
import { setAddressResolver } from "../utils/ssrf-protection";

const TEST_DB = "./data/test-plugin-catalog-service.db";

// A minimal but shape-valid catalog payload, distinguishable from the snapshot
// by its single made-up plugin id.
const REMOTE = {
  schema: 1,
  generated_at: "2026-09-01T00:00:00.000Z",
  plugins: [
    {
      id: "remote-only",
      name: "Remote Only",
      tagline: "Present in the remote catalog only.",
      description: "Body.",
      category: "productivity",
      status: "available",
      availability: "both",
      requires_feature: null,
      icon: "Clock",
      docs: "https://example.com/docs",
      source: null,
      screenshots: [],
      latest: { version: "2.0.0", min_app: "0.2.0", released: "2026-09-01" },
      versions: [{ version: "2.0.0", min_app: "0.2.0", released: "2026-09-01" }],
    },
  ],
};

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

/** Replace fetch for one test. `impl` receives the requested URL. */
function stubFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    return impl(url);
  }) as typeof fetch;
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();
  initDatabase();
  runMigrations();
  // The catalog fetch is SSRF-guarded, which resolves the host before opening a
  // socket. Stubbing fetch alone is not enough: without this the suite would
  // depend on live DNS for example.test, which does not resolve. A fixed public
  // address keeps every test below exercising the real guard.
  setAddressResolver(async () => ["93.184.216.34"]);
});

afterAll(() => {
  setAddressResolver(null);
  closeDatabase();
  // SQLite leaves -wal and -shm alongside the db; the existing suites clean all
  // three, and leaving them behind makes a later run start from stale state.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {
      // best effort
    }
  }
});

beforeEach(() => {
  fetchCalls = [];
  updateSettings({
    plugin_catalog_url: "",
    plugin_catalog_cache: "",
    plugin_catalog_synced_at: "",
    plugin_catalog_votes: "",
  });
  // Empty string means "off"; most tests want the default URL, so clear it by
  // writing the default back where needed.
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function enableEgress() {
  updateSettings({ plugin_catalog_url: "https://example.test/catalog.v1.json" });
}

describe("catalog service", () => {
  test("with egress off it never opens a socket and reports snapshot", async () => {
    stubFetch(() => {
      throw new Error("fetch must not be called");
    });
    const res = await getCatalog();
    expect(fetchCalls).toEqual([]);
    expect(res.source).toBe("snapshot");
    expect(res.catalog.schema).toBe(1);
    expect(res.catalog.plugins.some((p) => p.id === "time-tracker")).toBe(true);
  });

  test("a cold cache fetches remote and writes the cache and timestamp", async () => {
    enableEgress();
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog();
    expect(res.source).toBe("remote");
    expect(res.catalog.plugins[0]!.id).toBe("remote-only");
    expect(getSetting("plugin_catalog_cache")).toContain("remote-only");
    expect(getSetting("plugin_catalog_synced_at")).toBeTruthy();
    expect(fetchCalls).toHaveLength(1);
  });

  test("a fresh cache is used without fetching", async () => {
    enableEgress();
    stubFetch(() => ok(REMOTE));
    await getCatalog();
    fetchCalls = [];
    stubFetch(() => {
      throw new Error("must not refetch a fresh cache");
    });
    const res = await getCatalog();
    expect(res.source).toBe("cache");
    expect(fetchCalls).toEqual([]);
  });

  test("force bypasses a fresh cache", async () => {
    enableEgress();
    stubFetch(() => ok(REMOTE));
    await getCatalog();
    fetchCalls = [];
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog({ force: true });
    expect(res.source).toBe("remote");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a stale cache triggers a fetch", async () => {
    enableEgress();
    updateSettings({
      plugin_catalog_cache: JSON.stringify(REMOTE),
      plugin_catalog_synced_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog();
    expect(res.source).toBe("remote");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a failed fetch falls back to a stale cache and reports the error", async () => {
    enableEgress();
    updateSettings({
      plugin_catalog_cache: JSON.stringify(REMOTE),
      plugin_catalog_synced_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    stubFetch(() => Promise.reject(new Error("network down")));
    const res = await getCatalog();
    expect(res.source).toBe("cache");
    // The raw "network down" is logged, never returned: the code is coarse on
    // purpose so the response cannot be used to probe the network.
    expect(res.error).toBe("unreachable");
    expect(res.catalog.plugins[0]!.id).toBe("remote-only");
  });

  test("a failed fetch with no cache falls back to the snapshot", async () => {
    enableEgress();
    stubFetch(() => Promise.reject(new Error("network down")));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toBe("unreachable");
    expect(res.catalog.plugins.some((p) => p.id === "time-tracker")).toBe(true);
  });

  test("a non-200 response is treated as a failure", async () => {
    enableEgress();
    stubFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toBeTruthy();
  });

  test("a payload with the wrong schema version is rejected", async () => {
    enableEgress();
    stubFetch(() => ok({ ...REMOTE, schema: 2 }));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toBe("invalid_schema");
    expect(getSetting("plugin_catalog_cache")).toBeFalsy();
  });

  test("a structurally invalid payload is rejected", async () => {
    enableEgress();
    stubFetch(() => ok({ schema: 1, plugins: "not an array" }));
    const res = await getCatalog();
    expect(res.source).toBe("snapshot");
    expect(res.error).toBeTruthy();
  });

  test("a corrupt cache does not poison the result", async () => {
    enableEgress();
    updateSettings({
      plugin_catalog_cache: "{ not json",
      plugin_catalog_synced_at: new Date().toISOString(),
    });
    stubFetch(() => ok(REMOTE));
    const res = await getCatalog();
    expect(res.source).toBe("remote");
  });

  test("votes are fetched, cached, and empty when egress is off", async () => {
    enableEgress();
    stubFetch(() => ok({ "accounts-payable": 7 }));
    expect(await getVotes()).toEqual({ "accounts-payable": 7 });

    updateSettings({ plugin_catalog_url: "" });
    stubFetch(() => {
      throw new Error("must not fetch votes with egress off");
    });
    expect(await getVotes()).toEqual({});
  });

  test("a failed votes fetch falls back to the cached votes map", async () => {
    enableEgress();
    updateSettings({ plugin_catalog_votes: JSON.stringify({ "accounts-payable": 5 }) });
    stubFetch(() => Promise.reject(new Error("network down")));
    expect(await getVotes()).toEqual({ "accounts-payable": 5 });
  });

  test("postVote returns the new count and is a no-op when egress is off", async () => {
    enableEgress();
    stubFetch(() => ok({ count: 8, voted: true }));
    expect(await postVote("accounts-payable")).toBe(8);

    updateSettings({ plugin_catalog_url: "" });
    fetchCalls = [];
    stubFetch(() => {
      throw new Error("must not post a vote with egress off");
    });
    expect(await postVote("accounts-payable")).toBeNull();
    expect(fetchCalls).toEqual([]);
  });
});
