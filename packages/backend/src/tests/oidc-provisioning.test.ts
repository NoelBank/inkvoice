import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlinkSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { resolveOrProvisionUser } from "../services/oidc.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-oidc-provisioning.db";
const ISSUER = "https://auth.example.com";

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.OIDC_ISSUER_URL = ISSUER;
  process.env.OIDC_CLIENT_ID = "inkvoice";
  process.env.OIDC_CLIENT_SECRET = "secret";
  resetEnvCache();
  initDatabase();
  runMigrations();
});

afterAll(() => {
  closeDatabase();
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_AUTO_PROVISION;
  delete process.env.OIDC_ALLOWED_DOMAINS;
  resetEnvCache();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      unlinkSync(f);
    } catch {}
  }
});

async function insertPasswordUser(username: string, email: string, isAdmin = 0) {
  const db = getDb();
  db.run(
    "INSERT INTO users (id, username, email, display_name, password_hash, is_admin, role) VALUES (?, ?, ?, ?, 'hash', ?, 'Viewer')",
    [crypto.randomUUID().replace(/-/g, ""), username, email, username, isAdmin],
  );
  return db.query("SELECT id, username FROM users WHERE username = ?").get(username) as {
    id: string;
    username: string;
  };
}

describe("OIDC account resolution", () => {
  test("existing (issuer, subject) identity logs in", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO users (id, username, email, password_hash, is_admin, role, oidc_issuer, oidc_subject) VALUES ('x1', 'sso-user', 'sso@example.com', 'hash', 0, 'Viewer', ?, ?)",
      [ISSUER, "sub-existing"],
    );
    const res = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-existing",
      email: "sso@example.com",
      name: "SSO User",
      emailVerified: true,
    });
    expect(res.outcome).toBe("existing");
    expect(res.userId).toBe("x1");
    expect(res.username).toBe("sso-user");
    expect(res.isAdmin).toBe(false);
  });

  test("inactive identity is rejected with user_inactive", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO users (id, username, email, password_hash, is_admin, is_active, role, oidc_issuer, oidc_subject) VALUES ('x2', 'disabled-user', 'd@example.com', 'hash', 0, 0, 'Viewer', ?, ?)",
      [ISSUER, "sub-disabled"],
    );
    await expect(
      resolveOrProvisionUser(ISSUER, {
        subject: "sub-disabled",
        email: "d@example.com",
        name: "",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "user_inactive" });
  });

  test("verified email links an existing password account", async () => {
    const existing = await insertPasswordUser("alice", "alice@example.com");
    const res = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-alice",
      email: "ALICE@example.com",
      name: "Alice",
      emailVerified: true,
    });
    expect(res.outcome).toBe("linked");
    expect(res.userId).toBe(existing.id);
    const row = getDb()
      .query("SELECT oidc_issuer, oidc_subject FROM users WHERE id = ?")
      .get(existing.id) as { oidc_issuer: string; oidc_subject: string };
    expect(row.oidc_issuer).toBe(ISSUER);
    expect(row.oidc_subject).toBe("sub-alice");
  });

  test("verified email never rebinds an already-SSO-bound account", async () => {
    const db = getDb();
    // alice bound to sub-alice
    await resolveOrProvisionUser(ISSUER, {
      subject: "sub-alice",
      email: "alice@example.com",
      name: "Alice",
      emailVerified: true,
    });
    // a different subject, same verified email, must NOT rebind the row
    const res = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-alice2",
      email: "alice@example.com",
      name: "Alice",
      emailVerified: true,
    });
    expect(res.outcome).toBe("provisioned");
    expect(res.userId).not.toBe(
      (db.query("SELECT id FROM users WHERE oidc_subject = 'sub-alice'").get() as {
        id: string;
      } | null)!.id,
    );
    const bound = db
      .query("SELECT oidc_issuer, oidc_subject FROM users WHERE oidc_subject = 'sub-alice'")
      .get() as { oidc_issuer: string; oidc_subject: string };
    expect(bound.oidc_issuer).toBe(ISSUER);
    expect(bound.oidc_subject).toBe("sub-alice");
  });

  test("unverified email never links; JIT provisions instead", async () => {
    const db = getDb();
    db.run("UPDATE users SET email = 'bob@example.com' WHERE username = 'alice'");
    const res = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-bob",
      email: "bob@example.com",
      name: "Bob",
      emailVerified: false,
    });
    expect(res.outcome).toBe("provisioned");
    const row = db.query("SELECT * FROM users WHERE id = ?").get(res.userId) as Record<
      string,
      unknown
    >;
    expect(row.username).toBe("bob@example.com");
    expect(row.role).toBe("Viewer");
    expect(row.is_admin).toBe(0);
    expect(row.oidc_issuer).toBe(ISSUER);
    expect(row.oidc_subject).toBe("sub-bob");
  });

  test("JIT provisions Viewer with a random password hash", async () => {
    const res = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-carol",
      email: "carol@example.com",
      name: "Carol",
      emailVerified: true,
    });
    const row = getDb().query("SELECT * FROM users WHERE id = ?").get(res.userId) as Record<
      string,
      unknown
    >;
    expect(row.role).toBe("Viewer");
    expect(row.is_admin).toBe(0);
    expect(String(row.password_hash)).not.toBe("");
    expect(String(row.password_hash)).not.toBe("hash");
  });

  test("username suffix when the email is already another user's username", async () => {
    await insertPasswordUser("dave@example.com", "dave-other@example.com");
    const res = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-dave",
      email: "dave@example.com",
      name: "Dave",
      emailVerified: true,
    });
    const row = getDb().query("SELECT username FROM users WHERE id = ?").get(res.userId) as {
      username: string;
    };
    expect(row.username).toBe("dave@example.com-2");
  });

  test("AUTO_PROVISION=false rejects unknown identities", async () => {
    process.env.OIDC_AUTO_PROVISION = "false";
    resetEnvCache();
    await expect(
      resolveOrProvisionUser(ISSUER, {
        subject: "sub-x",
        email: "x@example.com",
        name: "",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "provisioning_disabled" });
    delete process.env.OIDC_AUTO_PROVISION;
    resetEnvCache();
  });

  test("domain allowlist gates JIT", async () => {
    process.env.OIDC_ALLOWED_DOMAINS = "example.com";
    resetEnvCache();
    const ok = await resolveOrProvisionUser(ISSUER, {
      subject: "sub-eve",
      email: "eve@example.com",
      name: "",
      emailVerified: false,
    });
    expect(ok.outcome).toBe("provisioned");
    await expect(
      resolveOrProvisionUser(ISSUER, {
        subject: "sub-mallory",
        email: "mallory@evil.com",
        name: "",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "domain_not_allowed" });
    delete process.env.OIDC_ALLOWED_DOMAINS;
    resetEnvCache();
  });
});
