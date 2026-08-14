import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bucketRateLimiter } from "../middleware/rate-limiter";
import { logActivity } from "../services/activity.service";
import {
  buildOidcAuthorizationUrl,
  discoverOidc,
  exchangeOidcCode,
  type OidcDiscoveryDocument,
  OidcLoginError,
  type OidcResolution,
  type OidcUserInfo,
  resolveOrProvisionUser,
} from "../services/oidc.service";
import { getEnv } from "../utils/env";
import { signToken } from "../utils/jwt";
import { logger } from "../utils/logger";
import { signOidcState, verifyOidcState } from "../utils/oidc-state";

const STATE_COOKIE = "oidc_state";
const STATE_TTL_SECONDS = 600;

type OidcErrorCode =
  | "invalid_state"
  | "auth_failed"
  | "email_required"
  | "unverified_email"
  | "domain_not_allowed"
  | "provisioning_disabled"
  | "user_inactive"
  | "misconfigured";

function errorRedirect(c: Context, code: OidcErrorCode) {
  return c.redirect(`/login?oidc_error=${code}`);
}

function redirectUri(c: Context): string {
  const base = getEnv().PUBLIC_BASE_URL;
  const origin = base || new URL(c.req.url).origin;
  return `${origin.replace(/\/+$/, "")}/api/v1/auth/oidc/callback`;
}

const oidcRoutes = new Hono();

oidcRoutes.get("/start", bucketRateLimiter("oidc-start", 10, 300), async (c) => {
  const env = getEnv();
  if (!env.OIDC_ENABLED) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  let doc: OidcDiscoveryDocument;
  try {
    doc = await discoverOidc();
  } catch (err) {
    logger.error({ err }, "OIDC discovery failed");
    return c.json({ success: false, error: "OIDC is not configured correctly" }, 503);
  }
  const start = buildOidcAuthorizationUrl(doc, redirectUri(c));
  const token = signOidcState({
    state: start.state,
    codeVerifier: start.codeVerifier,
    nonce: start.nonce,
  });
  setCookie(c, STATE_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Lax",
    maxAge: STATE_TTL_SECONDS,
    path: "/",
  });
  return c.redirect(start.url);
});

oidcRoutes.get("/callback", async (c) => {
  const env = getEnv();
  const code = c.req.query("code") || "";
  const state = c.req.query("state") || "";
  const claims = verifyOidcState(getCookie(c, STATE_COOKIE) ?? "");
  // Single-use: the state cookie never survives a callback attempt.
  deleteCookie(c, STATE_COOKIE, { path: "/" });

  if (!env.OIDC_ENABLED || !code || !claims || claims.state !== state) {
    return errorRedirect(c, "invalid_state");
  }

  let doc: OidcDiscoveryDocument;
  try {
    doc = await discoverOidc();
  } catch (err) {
    logger.error({ err }, "OIDC discovery failed");
    return errorRedirect(c, "misconfigured");
  }

  let userInfo: OidcUserInfo;
  try {
    userInfo = await exchangeOidcCode(doc, code, claims.codeVerifier, claims.nonce, redirectUri(c));
  } catch (err) {
    if (err instanceof OidcLoginError) {
      return errorRedirect(c, err.code);
    }
    logger.error({ err }, "OIDC token exchange failed");
    return errorRedirect(c, "auth_failed");
  }

  let resolution: OidcResolution;
  try {
    resolution = await resolveOrProvisionUser(env.OIDC_ISSUER_URL, userInfo);
  } catch (err) {
    if (err instanceof OidcLoginError) {
      return errorRedirect(c, err.code);
    }
    logger.error({ err }, "OIDC provisioning failed");
    return errorRedirect(c, "auth_failed");
  }

  const jwt = await signToken({
    sub: resolution.userId,
    username: resolution.username,
    is_admin: resolution.isAdmin,
  });
  setCookie(c, "session", jwt, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Strict",
    maxAge: env.SESSION_TTL,
    path: "/",
  });
  logActivity({
    user_id: resolution.userId,
    user_name: resolution.username,
    action: "login",
    resource_type: "user",
    resource_id: resolution.userId,
  });
  return c.redirect("/");
});

export { oidcRoutes };
