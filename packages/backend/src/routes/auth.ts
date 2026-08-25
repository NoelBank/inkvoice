import crypto from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { getDb } from "../database/connection";
import { authMiddleware } from "../middleware/auth";
import { bucketRateLimiter, rateLimiter } from "../middleware/rate-limiter";
import { logActivity } from "../services/activity.service";
import {
  getCurrentUser,
  isMfaRequired,
  issueSessionForUserId,
  login,
  type SessionResult,
} from "../services/auth.service";
import { sendEmail } from "../services/email.service";
import { passwordResetEmail } from "../services/email-templates";
import { getSetting } from "../services/settings.service";
import { getSystemMailSender } from "../services/system-mail";
import {
  beginEnrollment,
  confirmEnrollment,
  consumeChallenge,
  createChallenge,
  disableTwoFactor,
  getTwoFactorStatus,
  peekChallenge,
  verifySecondFactor,
} from "../services/totp.service";
import { getEnv } from "../utils/env";
import { hashPassword } from "../utils/password";

// Extension point: a deployment can override how password-reset links are
// built (e.g. per-tenant subdomains). Returning null falls back to the
// default PUBLIC_BASE_URL-based link.
type ResetUrlBuilder = (c: Context, token: string) => string | null;

let resetUrlBuilder: ResetUrlBuilder | null = null;

export function setResetUrlBuilder(fn: ResetUrlBuilder | null): void {
  resetUrlBuilder = fn;
}

const auth = new Hono();

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

/**
 * Strict locks the cookie to same-site requests, defeating CSRF on mutating
 * endpoints. The auth cookie isn't read on cross-site links — bookmarks and
 * direct navigations still work because Strict applies to top-level
 * navigations the same way as Lax for already-set cookies.
 */
function setSessionCookie(c: Context, token: string): void {
  const env = getEnv();
  setCookie(c, "session", token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Strict",
    maxAge: env.SESSION_TTL,
    path: "/",
  });
}

function completeLogin(c: Context, result: SessionResult, action: string) {
  setSessionCookie(c, result.token);
  logActivity({
    user_id: result.user.id,
    user_name: result.user.username,
    action,
    resource_type: "user",
    resource_id: result.user.id,
  });
  return c.json({ success: true, data: result });
}

auth.post("/login", rateLimiter, async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.parse(body);

  // A multi-tenant deployment's middleware sets c.get("tenant"). Bind the
  // issued token to that tenant so it can't be replayed against another
  // subdomain.
  const tenant = c.get("tenant") as { id: string } | undefined;
  const result = await login(parsed.username, parsed.password, tenant?.id);
  if (!result) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  // Password was right but the account has a second factor. No cookie is set
  // yet; the challenge token is the only thing that can finish this login.
  if (isMfaRequired(result)) {
    return c.json({
      success: true,
      data: { mfa_required: true, mfa_token: createChallenge(result.user_id, tenant?.id) },
    });
  }

  return completeLogin(c, result, "login");
});

const mfaVerifySchema = z.object({
  mfa_token: z.string().min(32),
  code: z.string().min(6).max(32),
});

// Rate-limited independently of the password step: six digits is a small
// keyspace, so unlimited guesses against a known challenge would defeat 2FA.
auth.post("/2fa/verify", bucketRateLimiter("mfa-verify", 10, 900), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = mfaVerifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid request" }, 400);
  }

  const challenge = peekChallenge(parsed.data.mfa_token);
  if (!challenge) {
    return c.json(
      { success: false, error: "This login attempt expired. Please sign in again." },
      401,
    );
  }

  const outcome = verifySecondFactor(challenge.user_id, parsed.data.code);
  if (outcome !== "ok") {
    // A replayed code is reported the same as a wrong one — telling an
    // attacker they guessed a real-but-spent code is free information.
    return c.json({ success: false, error: "Invalid code" }, 401);
  }

  consumeChallenge(parsed.data.mfa_token);
  const session = await issueSessionForUserId(challenge.user_id, challenge.tenant_id ?? undefined);
  if (!session) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  return completeLogin(c, session, "login_2fa");
});

auth.post("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ success: true });
});

// Forgot-password: ALWAYS returns 202 to avoid leaking whether an email is
// registered. Rate-limited per IP. The token is opaque (32 bytes hex) and
// is stored only in the tenant DB; no copy in logs or response.
const forgotSchema = z.object({ email: z.string().email() });

auth.post("/forgot-password", bucketRateLimiter("forgot-password", 3, 3600), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = forgotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: true }, 202); // don't reveal validation issues either
  }

  const db = getDb();
  const user = db
    .query("SELECT id, email, username FROM users WHERE email = ? AND is_active = 1")
    .get(parsed.data.email) as { id: string; email: string; username: string } | null;

  if (user?.email) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.run("INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)", [
      token,
      user.id,
      expiresAt,
    ]);

    // Deliberately no request-origin fallback: deriving the link base from
    // the Host header would enable reset-link poisoning.
    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const resetUrl = resetUrlBuilder?.(c, token) ?? `${base}/reset-password?token=${token}`;

    const sendMail = getSystemMailSender();
    if (sendMail) {
      // A registered platform sender (e.g. a hosted deployment) owns delivery.
      await sendMail({
        to: user.email,
        template: "password-reset",
        locale: "en",
        vars: { email: user.email, resetUrl },
      });
    } else {
      // Standalone install: deliver through the configured SMTP server. When
      // SMTP isn't configured this fails quietly — still 202, never leaking
      // whether the address exists.
      await sendEmail({
        to: user.email,
        ...passwordResetEmail({ email: user.email, reset_url: resetUrl }),
      });
    }
  }

  return c.json(
    { success: true, data: { message: "If this email is registered, a reset link was sent." } },
    202,
  );
});

const resetSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(12, "Password must be at least 12 characters"),
});

auth.post("/reset-password", bucketRateLimiter("reset-password", 10, 3600), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  }

  const db = getDb();
  const row = db
    .query("SELECT user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token = ?")
    .get(parsed.data.token) as {
    user_id: string;
    expires_at: string;
    consumed_at: string | null;
  } | null;

  if (!row || row.consumed_at) {
    return c.json({ success: false, error: "Invalid or already-used token" }, 410);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ success: false, error: "Token expired" }, 410);
  }

  const newHash = await hashPassword(parsed.data.password);
  db.transaction(() => {
    db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [
      newHash,
      row.user_id,
    ]);
    db.run("UPDATE password_reset_tokens SET consumed_at = datetime('now') WHERE token = ?", [
      parsed.data.token,
    ]);
    // Invalidate any other outstanding reset tokens for this user.
    db.run(
      "UPDATE password_reset_tokens SET consumed_at = datetime('now') WHERE user_id = ? AND consumed_at IS NULL",
      [row.user_id],
    );
  })();

  logActivity({
    user_id: row.user_id,
    user_name: "",
    action: "password_reset",
    resource_type: "user",
    resource_id: row.user_id,
  });

  return c.json({ success: true });
});

// --- Two-factor management (all require an existing session) ---

auth.get("/2fa", authMiddleware, (c) => {
  return c.json({ success: true, data: getTwoFactorStatus(c.get("userId")) });
});

auth.post("/2fa/setup", authMiddleware, (c) => {
  const issuer = getSetting("company_name")?.trim() || "Inkvoice";
  const enrollment = beginEnrollment(c.get("userId"), issuer);
  if (!enrollment) {
    return c.json({ success: false, error: "Two-factor authentication is already enabled" }, 409);
  }
  return c.json({ success: true, data: enrollment });
});

const codeSchema = z.object({ code: z.string().min(6).max(32) });

auth.post("/2fa/enable", authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = codeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid code" }, 400);
  }

  const userId = c.get("userId");
  const result = confirmEnrollment(userId, parsed.data.code);
  if (!result) {
    return c.json({ success: false, error: "Invalid code" }, 400);
  }

  logActivity({
    user_id: userId,
    user_name: c.get("user")?.username ?? "",
    action: "2fa_enabled",
    resource_type: "user",
    resource_id: userId,
  });
  // The only time the recovery codes are ever readable.
  return c.json({ success: true, data: result });
});

const disableSchema = z.object({ password: z.string().min(1) });

auth.post("/2fa/disable", authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = disableSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: "Password is required" }, 400);
  }

  const userId = c.get("userId");
  const ok = await disableTwoFactor(userId, parsed.data.password);
  if (!ok) {
    return c.json({ success: false, error: "Incorrect password" }, 401);
  }

  logActivity({
    user_id: userId,
    user_name: c.get("user")?.username ?? "",
    action: "2fa_disabled",
    resource_type: "user",
    resource_id: userId,
  });
  return c.json({ success: true });
});

auth.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const user = getCurrentUser(userId);
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  // Surface impersonation state so the SPA can render the banner.
  const payload = c.get("user") as
    | { impersonator_id?: string; impersonation_reason?: string }
    | undefined;
  const impersonation = payload?.impersonator_id
    ? { impersonator_id: payload.impersonator_id, reason: payload.impersonation_reason ?? null }
    : null;
  return c.json({ success: true, data: { ...user, impersonation } });
});

export { auth };
