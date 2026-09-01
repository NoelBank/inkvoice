import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlinkSync } from "node:fs";
import bcrypt from "bcryptjs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import "../plugins"; // registers time-tracker so its migrations run
import { runPluginMigrations } from "../plugins/runner";
import {
  type Actor,
  createEntry,
  createProject,
  deleteEntry,
  deleteProject,
  getSummary,
  listEntries,
  listProjects,
  setTimeEntryEditGuard,
  startTimer,
  stopTimer,
  updateEntry,
  updateProject,
} from "../plugins/time-tracker/service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-time-tracker.db";
let app: Hono;
let adminToken: string;

const admin: Actor = { userId: "admin-user-1", isAdmin: true };
const alice: Actor = { userId: "alice-user-2", isAdmin: false };
const bob: Actor = { userId: "bob-user-3", isAdmin: false };

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "tttestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
  await seed();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tttestadminpass" }),
  });
  adminToken = ((await res.json()) as any).data.token as string;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

function secondsAgo(s: number): string {
  return new Date(Date.now() - s * 1000).toISOString();
}

describe("time-tracker projects", () => {
  test("create, list, update, archive", () => {
    const p = createProject({ name: "Website", default_rate: 100, billable: true });
    expect(p.name).toBe("Website");
    expect(listProjects(false).some((x) => x.id === p.id)).toBe(true);
    const updated = updateProject(p.id, { name: "Website v2", is_archived: true });
    expect(updated?.name).toBe("Website v2");
    expect(updated?.is_archived).toBe(1);
    expect(listProjects(false).some((x) => x.id === p.id)).toBe(false);
    expect(listProjects(true).some((x) => x.id === p.id)).toBe(true);
    expect(deleteProject(p.id)).toBe(true);
  });
});

describe("time-tracker entries and timer", () => {
  let projectId: string;

  beforeAll(() => {
    projectId = createProject({ name: "Entries Test", default_rate: 50 }).id;
  });

  test("manual entry normalizes duration from ended_at", () => {
    const e = createEntry(alice.userId, {
      project_id: projectId,
      started_at: secondsAgo(3600),
      ended_at: secondsAgo(1800),
    });
    expect(e.duration_seconds).toBe(1800);
    expect(e.user_id).toBe(alice.userId);
  });

  test("timer start/stop rounds are per user", () => {
    const t = startTimer(alice.userId, { project_id: projectId });
    expect(t.ended_at).toBeNull();
    expect(startTimer(bob.userId, { project_id: projectId })).toBeTruthy();
    const stopped = stopTimer(alice.userId);
    expect(stopped?.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(stopTimer(bob.userId)?.ended_at).not.toBeNull();
  });

  test("non-admin lists and edits only own entries", () => {
    const mine = createEntry(alice.userId, {
      project_id: projectId,
      started_at: secondsAgo(600),
      duration_seconds: 600,
      description: "alice work",
    });
    const bobEntry = createEntry(bob.userId, {
      project_id: projectId,
      started_at: secondsAgo(300),
      description: "bob work",
    });

    const aliceList = listEntries(alice);
    expect(aliceList.some((e) => e.id === mine.id)).toBe(true);
    expect(aliceList.some((e) => e.id === bobEntry.id)).toBe(false);

    expect(updateEntry(bob, mine.id, { description: "hacked" })).toBeNull();
    expect(deleteEntry(bob, mine.id)).toBe(false);

    const adminList = listEntries(admin);
    expect(adminList.some((e) => e.id === mine.id)).toBe(true);
    expect(adminList.some((e) => e.id === bobEntry.id)).toBe(true);

    expect(updateEntry(admin, mine.id, { description: "admin edit" })?.description).toBe(
      "admin edit",
    );
    expect(deleteEntry(admin, mine.id)).toBe(true);
    deleteEntry(admin, bobEntry.id);
  });
});

describe("time-tracker edit guard", () => {
  test("setTimeEntryEditGuard blocks update and delete", () => {
    const projectId = createProject({ name: "Guard Test" }).id;
    const entry = createEntry(alice.userId, {
      project_id: projectId,
      started_at: secondsAgo(600),
      duration_seconds: 60,
    });

    setTimeEntryEditGuard(() => "locked");
    try {
      expect(() => updateEntry(alice, entry.id, { description: "x" })).toThrow("locked");
      expect(() => deleteEntry(alice, entry.id)).toThrow("locked");
    } finally {
      setTimeEntryEditGuard(null);
    }
    expect(updateEntry(alice, entry.id, { description: "ok" })?.description).toBe("ok");
    expect(deleteEntry(alice, entry.id)).toBe(true);
  });
});

describe("time-tracker summary scoping", () => {
  test("getSummary scopes seconds to the actor unless admin", () => {
    const projectId = createProject({ name: "Summary Test" }).id;
    createEntry(alice.userId, {
      project_id: projectId,
      started_at: secondsAgo(3600),
      duration_seconds: 1800,
    });
    createEntry(bob.userId, {
      project_id: projectId,
      started_at: secondsAgo(1800),
      duration_seconds: 900,
    });

    const aliceRows = getSummary(alice).filter((r) => r.project_id === projectId);
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].total_seconds).toBe(1800);

    const adminRows = getSummary(admin).filter((r) => r.project_id === projectId);
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0].total_seconds).toBe(2700);
  });
});

describe("time-tracker api", () => {
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    userId = crypto.randomBytes(16).toString("hex");
    const hash = await bcrypt.hash("tttestuserpass", 10);
    getDb().run(
      "INSERT INTO users (id, username, password_hash, is_admin, is_active) VALUES (?, ?, ?, 0, 1)",
      [userId, "tt_regular", hash],
    );
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tt_regular", password: "tttestuserpass" }),
    });
    userToken = ((await res.json()) as any).data.token as string;
  });

  function authed(token: string, path: string, opts: RequestInit = {}) {
    return app.request(
      new Request(`http://localhost${path}`, {
        ...opts,
        headers: {
          "Content-Type": "application/json",
          ...((opts.headers as Record<string, string>) || {}),
          Authorization: `Bearer ${token}`,
        },
      }),
    );
  }

  test("project create is admin-only", async () => {
    const asUser = await authed(userToken, "/api/v1/plugins/time-tracker/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(asUser.status).toBe(403);

    const asAdmin = await authed(adminToken, "/api/v1/plugins/time-tracker/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Admin Project" }),
    });
    expect(asAdmin.status).toBe(201);
  });

  test("project list is readable by non-admins", async () => {
    const res = await authed(userToken, "/api/v1/plugins/time-tracker/projects");
    expect(res.status).toBe(200);
  });

  test("entries are self-scoped for non-admins over the API", async () => {
    const projects = (await (
      await authed(adminToken, "/api/v1/plugins/time-tracker/projects")
    ).json()) as any;
    const projectId = projects.data[0].id;

    await authed(userToken, "/api/v1/plugins/time-tracker/entries", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId,
        started_at: new Date().toISOString(),
        duration_seconds: 120,
      }),
    });

    const list = (await (
      await authed(userToken, "/api/v1/plugins/time-tracker/entries")
    ).json()) as any;
    expect(list.data.length).toBeGreaterThan(0);
    for (const e of list.data) expect(e.user_id).toBe(userId);
  });

  test("invoice from time requires invoices:create", async () => {
    const res = await authed(userToken, "/api/v1/plugins/time-tracker/invoice", {
      method: "POST",
      body: JSON.stringify({ customer_id: "0000" }),
    });
    expect(res.status).toBe(403);
  });

  test("timer endpoints are per-user", async () => {
    const projects = (await (
      await authed(adminToken, "/api/v1/plugins/time-tracker/projects")
    ).json()) as any;
    const projectId = projects.data[0].id;

    const start = await authed(userToken, "/api/v1/plugins/time-tracker/timer/start", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId }),
    });
    expect(start.status).toBe(201);
    const stop = await authed(userToken, "/api/v1/plugins/time-tracker/timer/stop", {
      method: "POST",
    });
    expect(stop.status).toBe(200);
  });
});
