import crypto from "node:crypto";
import { getEnv } from "./env";

export interface OidcStateClaims {
  state: string;
  codeVerifier: string;
  nonce: string;
  iat: number;
  exp: number;
}

// Short TTL: the cookie only has to survive the provider round-trip.
export const STATE_TTL_SECONDS = 600;

/**
 * HMAC-SHA256-signed state container for the OIDC authorization-code flow.
 * Binds the provider's `state` param to the PKCE verifier and id_token nonce
 * issued by GET /start, so the callback can trust them. Verified by HMAC and
 * expiry; the cookie is single-use (deleted by the callback route).
 */
export function signOidcState(payload: Omit<OidcStateClaims, "iat" | "exp">): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: OidcStateClaims = { ...payload, iat: now, exp: now + STATE_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", getEnv().JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOidcState(token: string): OidcStateClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", getEnv().JWT_SECRET)
    .update(body)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<OidcStateClaims>;
    if (
      typeof claims.state !== "string" ||
      typeof claims.codeVerifier !== "string" ||
      typeof claims.nonce !== "string" ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return claims as OidcStateClaims;
  } catch {
    return null;
  }
}
