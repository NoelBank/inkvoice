import crypto from "node:crypto";
import { CodeChallengeMethod, generateCodeVerifier, generateState, OAuth2Client } from "arctic";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getEnv } from "../utils/env";

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcUserInfo {
  subject: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface OidcAuthStart {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10_000;

interface DiscoveryCacheEntry {
  doc: OidcDiscoveryDocument;
  fetchedAt: number;
}

let discoveryCache: DiscoveryCacheEntry | null = null;

export function resetOidcServiceForTesting(): void {
  discoveryCache = null;
}

export async function discoverOidc(): Promise<OidcDiscoveryDocument> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.doc;
  }
  const env = getEnv();
  const url = `${env.OIDC_ISSUER_URL}/.well-known/openid-configuration`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const missing = (
    ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const
  ).filter((k) => typeof raw[k] !== "string" || raw[k] === "");
  if (missing.length > 0) {
    throw new Error(`OIDC discovery document missing fields: ${missing.join(", ")}`);
  }
  const doc: OidcDiscoveryDocument = {
    issuer: raw.issuer as string,
    authorization_endpoint: raw.authorization_endpoint as string,
    token_endpoint: raw.token_endpoint as string,
    jwks_uri: raw.jwks_uri as string,
  };
  if (doc.issuer !== env.OIDC_ISSUER_URL) {
    throw new Error("OIDC discovery issuer mismatch");
  }
  discoveryCache = { doc, fetchedAt: Date.now() };
  return doc;
}

export function oidcScopes(): string[] {
  const scopes = getEnv()
    .OIDC_SCOPE.split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  return scopes;
}

export function buildOidcAuthorizationUrl(
  doc: OidcDiscoveryDocument,
  redirectUri: string,
): OidcAuthStart {
  const env = getEnv();
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const nonce = crypto.randomBytes(16).toString("hex");
  const client = new OAuth2Client(env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET, redirectUri);
  const url = client.createAuthorizationURLWithPKCE(
    doc.authorization_endpoint,
    state,
    CodeChallengeMethod.S256,
    codeVerifier,
    oidcScopes(),
  );
  url.searchParams.set("nonce", nonce);
  return { url: url.toString(), state, codeVerifier, nonce };
}

/**
 * Verifies an id_token against the discovered JWKS and the configured
 * issuer/client, then checks the nonce binding. Throws on any mismatch.
 */
export async function validateIdToken(idToken: string, nonce: string): Promise<OidcUserInfo> {
  const env = getEnv();
  const doc = await discoverOidc();
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: env.OIDC_ISSUER_URL,
    audience: env.OIDC_CLIENT_ID,
  });
  if (payload.nonce !== nonce) {
    throw new Error("OIDC id_token nonce mismatch");
  }
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  const email =
    typeof (payload as { email?: unknown }).email === "string"
      ? (payload as { email: string }).email
      : "";
  if (!subject || !email) {
    throw new Error("OIDC id_token missing sub/email");
  }
  const ev = (payload as { email_verified?: unknown }).email_verified;
  const name =
    typeof (payload as { name?: unknown }).name === "string"
      ? (payload as { name: string }).name
      : "";
  return {
    subject,
    email,
    name,
    emailVerified: ev === true || ev === "true",
  };
}

// Test seam: replaces the arctic token-exchange portion so route tests can
// exercise the callback without network calls.
type CallbackOverride = (code: string, codeVerifier: string | undefined) => Promise<OidcUserInfo>;

let callbackOverride: CallbackOverride | null = null;

export function setOidcCallbackOverride(fn: CallbackOverride | null): void {
  callbackOverride = fn;
}

/**
 * Authorization-code exchange: arctic talks to the discovered token endpoint
 * (Basic auth, PKCE verifier, redirect_uri), then the id_token is validated
 * by validateIdToken.
 */
export async function exchangeOidcCode(
  doc: OidcDiscoveryDocument,
  code: string,
  codeVerifier: string | undefined,
  nonce: string,
  redirectUri: string,
): Promise<OidcUserInfo> {
  if (callbackOverride) return callbackOverride(code, codeVerifier);
  const env = getEnv();
  const client = new OAuth2Client(env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET, redirectUri);
  const tokens = await client.validateAuthorizationCode(
    doc.token_endpoint,
    code,
    codeVerifier ?? null,
  );
  return validateIdToken(tokens.idToken(), nonce);
}
