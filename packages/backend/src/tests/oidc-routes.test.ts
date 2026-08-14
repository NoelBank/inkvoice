import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import {
  OidcLoginError,
  type OidcUserInfo,
  setOidcCallbackOverride,
} from "../services/oidc.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-oidc-routes.db";
let app: Hono;
let issuer: string;
let server: ReturnType<typeof Bun.serve>;
let certDir: string | null = null;
let prevTlsRejectUnauthorized: string | undefined;

function cookieHeader(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

function cookieValue(res: Response, name: string): string | null {
  const raw = cookieHeader(res);
  const m = raw.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

beforeAll(async () => {
  // The stub issuer must be https: env.ts rejects any non-https
  // OIDC_ISSUER_URL, so serve it over TLS with a throwaway self-signed cert
  // and disable certificate verification for this test process.
  certDir = mkdtempSync(join(tmpdir(), "inkvoice-oidc-routes-"));
  const certPath = join(certDir, "cert.pem");
  const keyPath = join(certDir, "key.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(`openssl cert generation failed: ${result.stderr?.toString()}`);
  }

  server = Bun.serve({
    port: 0,
    tls: {
      cert: await Bun.file(certPath).text(),
      key: await Bun.file(keyPath).text(),
    },
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  issuer = `https://127.0.0.1:${server.port}`;

  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.OIDC_ISSUER_URL = issuer;
  process.env.OIDC_CLIENT_ID = "inkvoice";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_AUTO_PROVISION = "true";
  prevTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  resetEnvCache();

  initDatabase();
  runMigrations();
  app = createApp();
});

afterAll(() => {
  setOidcCallbackOverride(null);
  server.stop(true);
  closeDatabase();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      unlinkSync(f);
    } catch {}
  }
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (prevTlsRejectUnauthorized !== undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsRejectUnauthorized;
  }
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

describe("GET /api/v1/auth/oidc/start", () => {
  test("redirects to the provider with state, PKCE and a signed state cookie", async () => {
    const res = await app.request("/api/v1/auth/oidc/start");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(issuer);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost/api/v1/auth/oidc/callback",
    );
    const stateParam = location.searchParams.get("state")!;
    expect(stateParam).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(cookieHeader(res)).toContain("oidc_state=");
  });

  test("PUBLIC_BASE_URL overrides the redirect origin", async () => {
    process.env.PUBLIC_BASE_URL = "https://invoices.example.com/";
    resetEnvCache();
    const res = await app.request("/api/v1/auth/oidc/start");
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://invoices.example.com/api/v1/auth/oidc/callback",
    );
    delete process.env.PUBLIC_BASE_URL;
    resetEnvCache();
  });

  test("returns 404 when SSO is disabled", async () => {
    process.env.OIDC_ISSUER_URL = "";
    resetEnvCache();
    const res = await app.request("/api/v1/auth/oidc/start");
    expect(res.status).toBe(404);
    process.env.OIDC_ISSUER_URL = issuer;
    resetEnvCache();
  });
});

describe("GET /api/v1/auth/oidc/callback", () => {
  async function runFlow(
    override: () => Promise<OidcUserInfo>,
  ): Promise<{ startRes: Response; cbRes: Response }> {
    const startRes = await app.request("/api/v1/auth/oidc/start");
    const location = new URL(startRes.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const cookie = cookieValue(startRes, "oidc_state")!;
    setOidcCallbackOverride(override);
    const cbRes = await app.request(
      `/api/v1/auth/oidc/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `oidc_state=${cookie}` } },
    );
    setOidcCallbackOverride(null);
    return { startRes, cbRes };
  }

  test("happy path provisions a user, sets the session cookie and redirects to /", async () => {
    const { cbRes } = await runFlow(async () => ({
      subject: "sub-new",
      email: "new@example.com",
      name: "New User",
      emailVerified: true,
    }));
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe("/");
    expect(cookieHeader(cbRes)).toContain("session=");

    const sessionCookie = cookieValue(cbRes, "session")!;
    const meRes = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { data: { username: string; role: string } };
    expect(me.data.username).toBe("new@example.com");
    expect(me.data.role).toBe("Viewer");
  });

  test("second login matches the existing identity", async () => {
    const { cbRes } = await runFlow(async () => ({
      subject: "sub-new",
      email: "new@example.com",
      name: "New User",
      emailVerified: true,
    }));
    expect(cbRes.status).toBe(302);
    const users = getDb()
      .query("SELECT COUNT(*) as c FROM users WHERE username = 'new@example.com'")
      .get() as { c: number };
    expect(users.c).toBe(1);
  });

  test("missing or mismatched state is rejected with invalid_state", async () => {
    const res = await app.request("/api/v1/auth/oidc/callback?code=code-1&state=wrong-state");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("oidc_error=invalid_state");
  });

  test("provider exchange failure maps to auth_failed", async () => {
    const { cbRes } = await runFlow(async () => {
      throw new Error("provider says no");
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toContain("oidc_error=auth_failed");
  });

  test("OidcLoginError codes are surfaced in the redirect", async () => {
    const { cbRes } = await runFlow(async () => {
      throw new OidcLoginError("domain_not_allowed", "nope");
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toContain("oidc_error=domain_not_allowed");
  });
});
