import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import "../plugins"; // registers time-tracker so its migrations run
import { runPluginMigrations } from "../plugins/runner";
import {
  type Actor,
  createEntry,
  createProject,
  deleteEntry,
  deleteProject,
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

const admin: Actor = { userId: "admin-user-1", isAdmin: true };
const alice: Actor = { userId: "alice-user-2", isAdmin: false };
const bob: Actor = { userId: "bob-user-3", isAdmin: false };

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "tttestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
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
    } finally {
      setTimeEntryEditGuard(null);
    }
    expect(updateEntry(alice, entry.id, { description: "ok" })?.description).toBe("ok");
  });
});
