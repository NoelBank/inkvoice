import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resetEnvCache } from "../utils/env";
import { signOidcState, verifyOidcState } from "../utils/oidc-state";

const SECRET = "test-secret-key-that-is-at-least-32-chars-long";

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  resetEnvCache();
});

afterAll(() => resetEnvCache());

function expiredToken(): string {
  // Build a token whose exp is already in the past, using the same wire
  // format as signOidcState (base64url(JSON) + "." + base64url(HMAC-SHA256)).
  const claims = {
    state: "s",
    codeVerifier: "v",
    nonce: "n",
    iat: Math.floor(Date.now() / 1000) - 60_000,
    exp: Math.floor(Date.now() / 1000) - 60,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

describe("OIDC signed state cookie", () => {
  test("sign then verify round-trips the claims", () => {
    const token = signOidcState({ state: "abc", codeVerifier: "verifier-1", nonce: "nonce-1" });
    const claims = verifyOidcState(token);
    expect(claims).not.toBeNull();
    expect(claims!.state).toBe("abc");
    expect(claims!.codeVerifier).toBe("verifier-1");
    expect(claims!.nonce).toBe("nonce-1");
    expect(claims!.exp - claims!.iat).toBe(600);
  });

  test("tampered body fails validation", () => {
    const token = signOidcState({ state: "abc", codeVerifier: "v", nonce: "n" });
    const [_body, sig] = token.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ state: "evil", codeVerifier: "v", nonce: "n" }),
    ).toString("base64url");
    expect(verifyOidcState(`${tamperedBody}.${sig}`)).toBeNull();
  });

  test("tampered signature fails validation", () => {
    const token = signOidcState({ state: "abc", codeVerifier: "v", nonce: "n" });
    expect(verifyOidcState(`${token}x`)).toBeNull();
    expect(verifyOidcState("garbage")).toBeNull();
  });

  test("token signed with a different secret fails validation", () => {
    const claims = {
      state: "abc",
      codeVerifier: "v",
      nonce: "n",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = createHmac("sha256", "another-secret-that-is-long-enough-12345")
      .update(body)
      .digest("base64url");
    expect(verifyOidcState(`${body}.${sig}`)).toBeNull();
  });

  test("expired token fails validation", () => {
    expect(verifyOidcState(expiredToken())).toBeNull();
  });
});
