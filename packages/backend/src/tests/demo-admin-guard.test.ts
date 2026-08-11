import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-demo-admin-guard.db";
let app: Hono;
let token: string;
/** The seeded admin — the account every demo visitor signs in with. */
let demoAdminId: string;

function removeDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
}

function setDemoMode(on: boolean): void {
  if (on) process.env.DEMO_MODE = "true";
  else delete process.env.DEMO_MODE;
  resetEnvCache();
}

function authedAs(bearer: string) {
  return (path: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = {
      ...((opts.headers as Record<string, string>) || {}),
      Authorization: `Bearer ${bearer}`,
    };
    if (opts.method && opts.method !== "GET") headers["Content-Type"] = "application/json";
    return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
  };
}

const authed = (path: string, opts: RequestInit = {}) => authedAs(token)(path, opts);

async function login(username: string, password: string) {
  return app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

/** PUT the demo admin the way the SPA does: the whole form, changes and all. */
async function putDemoAdmin(patch: Record<string, unknown>) {
  return authed(`/api/v1/users/${demoAdminId}`, {
    method: "PUT",
    body: JSON.stringify({
      username: "demo",
      email: "",
      display_name: "Demo Owner",
      is_admin: 1,
      is_active: 1,
      role: "Owner",
      ...patch,
    }),
  });
}

async function expectLocked(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { success: boolean; code?: string; error?: string };
  expect(body.success).toBe(false);
  expect(body.code).toBe("DEMO_ACCOUNT_LOCKED");
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  // No ADMIN_USER/ADMIN_PASS: DEMO_MODE seeds the throwaway demo/demo pair.
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  setDemoMode(true);
  removeDb();

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  const res = await login("demo", "demo");
  const data = (await res.json()) as { data: { token: string; user: { id: string } } };
  token = data.data.token;
  demoAdminId = data.data.user.id;
});

afterAll(() => {
  delete process.env.DEMO_MODE;
  delete process.env.RATE_LIMIT_ENABLED;
  resetEnvCache();
  closeDatabase();
  removeDb();
});

describe("PUT /api/v1/users/:id with DEMO_MODE on", () => {
  test("refuses to change the demo admin's password", async () => {
    await expectLocked(await putDemoAdmin({ password: "hijacked-by-a-visitor" }));
  });

  test("refuses to rename the demo admin", async () => {
    await expectLocked(await putDemoAdmin({ username: "notdemo" }));
  });

  test("refuses to deactivate the demo admin", async () => {
    await expectLocked(await putDemoAdmin({ is_active: 0 }));
  });

  test("still allows every other edit on the demo admin", async () => {
    // The SPA always sends username and is_active, unchanged — echoing the
    // current values back must not trip the guard.
    const res = await putDemoAdmin({ display_name: "Demo User", email: "demo@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { display_name: string; email: string } };
    expect(body.data.display_name).toBe("Demo User");
    expect(body.data.email).toBe("demo@example.com");
  });

  test("the advertised demo credentials still work afterwards", async () => {
    const res = await login("demo", "demo");
    expect(res.status).toBe(200);
  });

  test("leaves other accounts fully editable", async () => {
    const created = await authed("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ username: "visitor", password: "visitor-password" }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await authed(`/api/v1/users/${data.id}`, {
      method: "PUT",
      body: JSON.stringify({ username: "visitor2", password: "another-password", is_active: 0 }),
    });
    expect(res.status).toBe(200);
  });
});

describe("deleting the demo admin", () => {
  // A visitor can promote themselves out of the "cannot touch your own account"
  // rules that keep the demo admin alive on the delete and batch routes: make a
  // second admin, sign in as it, and the demo account is someone else's.
  let other: ReturnType<typeof authedAs>;

  beforeAll(async () => {
    const created = await authed("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: "secondadmin",
        password: "second-admin-password",
        is_admin: 1,
        role: "Admin",
      }),
    });
    expect(created.status).toBe(201);
    const res = await login("secondadmin", "second-admin-password");
    const body = (await res.json()) as { data: { token: string } };
    other = authedAs(body.data.token);
  });

  test("DELETE /api/v1/users/:id is refused", async () => {
    await expectLocked(await other(`/api/v1/users/${demoAdminId}`, { method: "DELETE" }));
  });

  test("batch deactivate and delete skip the demo admin", async () => {
    for (const action of ["deactivate", "delete"]) {
      const res = await other("/api/v1/users/batch", {
        method: "POST",
        body: JSON.stringify({ ids: [demoAdminId], action }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { succeeded: number; failed: number; errors: { id: string; reason: string }[] };
      };
      expect(body.data.succeeded).toBe(0);
      expect(body.data.errors).toEqual([
        { id: demoAdminId, reason: expect.stringContaining("demo account") },
      ]);
    }
    // Unharmed: still the account the login page advertises.
    expect((await login("demo", "demo")).status).toBe(200);
  });
});

describe("without DEMO_MODE", () => {
  test("the same admin account is editable again", async () => {
    setDemoMode(false);
    const res = await putDemoAdmin({ password: "a-perfectly-normal-password" });
    expect(res.status).toBe(200);
  });
});
