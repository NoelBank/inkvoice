import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetEnvCache } from "../utils/env";
import { counterForTime, totpCode } from "../utils/totp";

const TEST_DB = "./data/test-two-factor.db";
const PASSWORD = "twofactortestpass";

let app: Hono;
let token: string;

async function post(path: string, body: unknown, bearer?: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as any };
}

async function get(path: string, bearer = token) {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${bearer}` } });
  return { res, body: (await res.json()) as any };
}

async function loginRaw(password = PASSWORD) {
  return post("/api/v1/auth/login", { username: "admin", password });
}

// Nested beforeAll hooks run eagerly in Bun (before tests of *earlier*
// describes), so every test sets up the state it needs itself.
function resetTwoFactorState(): void {
  const db = getDb();
  db.run(
    "UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL, totp_last_counter = NULL WHERE username = 'admin'",
  );
  db.run("DELETE FROM user_recovery_codes");
  db.run("DELETE FROM mfa_challenges");
}

/** Runs the real setup + enable round-trip. */
async function enroll(): Promise<{ secret: string; recoveryCodes: string[] }> {
  resetTwoFactorState();
  const setup = await post("/api/v1/auth/2fa/setup", {}, token);
  const secret = setup.body.data.secret as string;
  const enable = await post(
    "/api/v1/auth/2fa/enable",
    { code: totpCode(secret, counterForTime()) },
    token,
  );
  expect(enable.res.status).toBe(200);
  return { secret, recoveryCodes: enable.body.data.recovery_codes as string[] };
}

/**
 * Codes are single-use, so a suite that logs in repeatedly inside one 30-second
 * window would trip replay protection. Clearing the high-water mark stands in
 * for "the clock moved on".
 */
function advanceWindow(): void {
  getDb().run("UPDATE users SET totp_last_counter = NULL WHERE username = 'admin'");
}

async function completeLogin(secret: string): Promise<string> {
  advanceWindow();
  const challenge = await loginRaw();
  const verified = await post("/api/v1/auth/2fa/verify", {
    mfa_token: challenge.body.data.mfa_token,
    code: totpCode(secret, counterForTime()),
  });
  expect(verified.res.status).toBe(200);
  return verified.body.data.token as string;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = PASSWORD;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  token = (await loginRaw()).body.data.token;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("without 2FA", () => {
  test("login issues a session directly", async () => {
    resetTwoFactorState();
    const { res, body } = await loginRaw();
    expect(res.status).toBe(200);
    expect(body.data.token).toBeString();
    expect(body.data.mfa_required).toBeUndefined();
  });

  test("status reports 2FA off", async () => {
    resetTwoFactorState();
    const { body } = await get("/api/v1/auth/2fa");
    expect(body.data.enabled).toBe(false);
    expect(body.data.pending).toBe(false);
    expect(body.data.recovery_codes_remaining).toBe(0);
  });
});

describe("enrollment", () => {
  test("setup returns a secret, otpauth URI and QR image", async () => {
    resetTwoFactorState();
    const { res, body } = await post("/api/v1/auth/2fa/setup", {}, token);
    expect(res.status).toBe(200);
    expect(body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.data.otpauth_uri).toStartWith("otpauth://totp/");
    expect(body.data.qr).toStartWith("data:image/svg+xml");
  });

  test("a pending secret does not enable 2FA on its own", async () => {
    resetTwoFactorState();
    await post("/api/v1/auth/2fa/setup", {}, token);

    const status = await get("/api/v1/auth/2fa");
    expect(status.body.data.enabled).toBe(false);
    expect(status.body.data.pending).toBe(true);

    const { body } = await loginRaw();
    expect(body.data.mfa_required).toBeUndefined();
    expect(body.data.token).toBeString();
  });

  test("enable rejects a wrong code and keeps 2FA off", async () => {
    resetTwoFactorState();
    await post("/api/v1/auth/2fa/setup", {}, token);

    const { res } = await post("/api/v1/auth/2fa/enable", { code: "000000" }, token);
    expect(res.status).toBe(400);
    expect((await get("/api/v1/auth/2fa")).body.data.enabled).toBe(false);
  });

  test("enable with a valid code switches 2FA on and returns 10 unique recovery codes", async () => {
    const { recoveryCodes } = await enroll();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const { body } = await get("/api/v1/auth/2fa");
    expect(body.data.enabled).toBe(true);
    expect(body.data.recovery_codes_remaining).toBe(10);
  });

  test("re-enrolling invalidates the previous recovery codes", async () => {
    const first = await enroll();
    await enroll();

    advanceWindow();
    const challenge = await loginRaw();
    const { res } = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: first.recoveryCodes[0],
    });
    expect(res.status).toBe(401);
  });

  test("setup is refused while 2FA is active", async () => {
    await enroll();
    const { res } = await post("/api/v1/auth/2fa/setup", {}, token);
    expect(res.status).toBe(409);
  });

  test("recovery codes are stored hashed, never in the clear", async () => {
    const { recoveryCodes } = await enroll();
    const rows = getDb().query("SELECT code_hash FROM user_recovery_codes").all() as {
      code_hash: string;
    }[];
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(recoveryCodes).not.toContain(row.code_hash);
    }
  });
});

describe("login with 2FA enabled", () => {
  test("password alone yields a challenge, not a session", async () => {
    await enroll();
    const { res, body } = await loginRaw();
    expect(res.status).toBe(200);
    expect(body.data.mfa_required).toBe(true);
    expect(body.data.mfa_token).toBeString();
    expect(body.data.token).toBeUndefined();
  });

  test("a wrong password fails before the second factor is even asked for", async () => {
    await enroll();
    const { res, body } = await loginRaw("definitely-wrong");
    expect(res.status).toBe(401);
    expect(body.data).toBeUndefined();
  });

  test("the challenge token is not usable as a session token", async () => {
    await enroll();
    const { body } = await loginRaw();
    const res = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${body.data.mfa_token}` },
    });
    expect(res.status).toBe(401);
  });

  test("a valid code completes the login", async () => {
    const { secret } = await enroll();
    advanceWindow();
    const challenge = await loginRaw();
    const { res, body } = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: totpCode(secret, counterForTime()),
    });
    expect(res.status).toBe(200);
    expect(body.data.token).toBeString();
    expect(body.data.user.username).toBe("admin");
  });

  test("a code one step out of sync is still accepted", async () => {
    const { secret } = await enroll();
    for (const drift of [-1, 1]) {
      advanceWindow();
      const challenge = await loginRaw();
      const { res } = await post("/api/v1/auth/2fa/verify", {
        mfa_token: challenge.body.data.mfa_token,
        code: totpCode(secret, counterForTime() + drift),
      });
      expect(res.status).toBe(200);
    }
  });

  test("the same code cannot be replayed on a fresh challenge", async () => {
    const { secret } = await enroll();
    advanceWindow();
    const code = totpCode(secret, counterForTime());

    const first = await loginRaw();
    const ok = await post("/api/v1/auth/2fa/verify", {
      mfa_token: first.body.data.mfa_token,
      code,
    });
    expect(ok.res.status).toBe(200);

    // No advanceWindow(): this is exactly the replay the counter guards against.
    const second = await loginRaw();
    const replay = await post("/api/v1/auth/2fa/verify", {
      mfa_token: second.body.data.mfa_token,
      code,
    });
    expect(replay.res.status).toBe(401);
  });

  test("a wrong code is rejected but the challenge survives for a retry", async () => {
    const { secret } = await enroll();
    advanceWindow();
    const challenge = await loginRaw();

    const bad = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: "000000",
    });
    expect(bad.res.status).toBe(401);

    const good = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: totpCode(secret, counterForTime()),
    });
    expect(good.res.status).toBe(200);
  });

  test("an unknown challenge token is rejected", async () => {
    const { secret } = await enroll();
    advanceWindow();
    const { res } = await post("/api/v1/auth/2fa/verify", {
      mfa_token: "f".repeat(64),
      code: totpCode(secret, counterForTime()),
    });
    expect(res.status).toBe(401);
  });

  test("an expired challenge is rejected", async () => {
    const { secret } = await enroll();
    advanceWindow();
    const challenge = await loginRaw();
    getDb().run(
      "UPDATE mfa_challenges SET expires_at = datetime('now', '-1 minute') WHERE token = ?",
      [challenge.body.data.mfa_token],
    );
    const { res } = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: totpCode(secret, counterForTime()),
    });
    expect(res.status).toBe(401);
  });

  test("a consumed challenge cannot be reused", async () => {
    const { secret } = await enroll();
    advanceWindow();
    const challenge = await loginRaw();

    const first = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: totpCode(secret, counterForTime()),
    });
    expect(first.res.status).toBe(200);

    advanceWindow();
    const reuse = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: totpCode(secret, counterForTime()),
    });
    expect(reuse.res.status).toBe(401);
  });

  test("a recovery code works once and is then spent", async () => {
    const { recoveryCodes } = await enroll();
    const code = recoveryCodes[0];

    const first = await loginRaw();
    const ok = await post("/api/v1/auth/2fa/verify", {
      mfa_token: first.body.data.mfa_token,
      code,
    });
    expect(ok.res.status).toBe(200);
    expect((await get("/api/v1/auth/2fa")).body.data.recovery_codes_remaining).toBe(9);

    const second = await loginRaw();
    const reuse = await post("/api/v1/auth/2fa/verify", {
      mfa_token: second.body.data.mfa_token,
      code,
    });
    expect(reuse.res.status).toBe(401);
  });

  test("a recovery code is accepted in any casing or spacing", async () => {
    const { recoveryCodes } = await enroll();
    const challenge = await loginRaw();
    const { res } = await post("/api/v1/auth/2fa/verify", {
      mfa_token: challenge.body.data.mfa_token,
      code: recoveryCodes[3].toUpperCase().replace("-", " "),
    });
    expect(res.status).toBe(200);
  });
});

describe("disabling", () => {
  test("a wrong password does not disable 2FA", async () => {
    const { secret } = await enroll();
    const active = await completeLogin(secret);

    const { res } = await post("/api/v1/auth/2fa/disable", { password: "wrong" }, active);
    expect(res.status).toBe(401);
    expect((await get("/api/v1/auth/2fa", active)).body.data.enabled).toBe(true);
  });

  test("the correct password disables 2FA and clears recovery codes", async () => {
    const { secret } = await enroll();
    const active = await completeLogin(secret);

    const { res } = await post("/api/v1/auth/2fa/disable", { password: PASSWORD }, active);
    expect(res.status).toBe(200);

    const { body } = await get("/api/v1/auth/2fa", active);
    expect(body.data.enabled).toBe(false);
    expect(body.data.recovery_codes_remaining).toBe(0);

    const login = await loginRaw();
    expect(login.body.data.token).toBeString();
  });
});
