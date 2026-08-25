import crypto from "node:crypto";
import { getDb } from "../database/connection";
import { verifyPassword } from "../utils/password";
import { qrToDataUri } from "../utils/qr-code";
import { buildOtpauthUri, generateSecret, verifyTotp } from "../utils/totp";

const RECOVERY_CODE_COUNT = 10;
/** How long the half-authenticated login step stays valid. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface TwoFactorStatus {
  enabled: boolean;
  confirmed_at: string | null;
  /** Unused recovery codes left; 0 means the user can only get in via the app. */
  recovery_codes_remaining: number;
  /** True once a secret has been issued but not yet confirmed with a code. */
  pending: boolean;
}

interface TotpUserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_confirmed_at: string | null;
  totp_last_counter: number | null;
}

function getUser(userId: string): TotpUserRow | null {
  return getDb()
    .query(
      `SELECT id, username, password_hash, totp_secret, totp_enabled, totp_confirmed_at, totp_last_counter
       FROM users WHERE id = ? AND is_active = 1`,
    )
    .get(userId) as TotpUserRow | null;
}

/** High-entropy secrets don't need a slow KDF — same reasoning as api_tokens. */
function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function generateRecoveryCode(): string {
  const raw = crypto.randomBytes(5).toString("hex"); // 10 hex chars
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function getTwoFactorStatus(userId: string): TwoFactorStatus {
  const user = getUser(userId);
  if (!user) {
    return { enabled: false, confirmed_at: null, recovery_codes_remaining: 0, pending: false };
  }
  const remaining = getDb()
    .query("SELECT COUNT(*) as cnt FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .get(userId) as { cnt: number };

  return {
    enabled: !!user.totp_enabled,
    confirmed_at: user.totp_confirmed_at,
    recovery_codes_remaining: remaining.cnt,
    pending: !user.totp_enabled && !!user.totp_secret,
  };
}

export function isTwoFactorEnabled(userId: string): boolean {
  const user = getUser(userId);
  return !!user?.totp_enabled && !!user.totp_secret;
}

/**
 * Issues a fresh secret without switching 2FA on — the user has to prove the
 * authenticator works first (confirmEnrollment). Re-running this before
 * confirmation replaces the pending secret, so an abandoned setup can't be
 * resumed with a stale QR code.
 */
export function beginEnrollment(
  userId: string,
  issuer: string,
): { secret: string; otpauth_uri: string; qr: string } | null {
  const user = getUser(userId);
  if (!user) return null;
  if (user.totp_enabled) return null; // disable first, don't silently re-key

  const secret = generateSecret();
  getDb().run(
    "UPDATE users SET totp_secret = ?, totp_confirmed_at = NULL, totp_last_counter = NULL, updated_at = datetime('now') WHERE id = ?",
    [secret, userId],
  );

  const uri = buildOtpauthUri({ secret, account: user.username, issuer });
  return { secret, otpauth_uri: uri, qr: qrToDataUri(uri) };
}

export function confirmEnrollment(
  userId: string,
  code: string,
): { recovery_codes: string[] } | null {
  const db = getDb();
  const user = getUser(userId);
  if (!user?.totp_secret || user.totp_enabled) return null;

  const result = verifyTotp(user.totp_secret, code);
  if (!result.valid) return null;

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  db.transaction(() => {
    db.run(
      "UPDATE users SET totp_enabled = 1, totp_confirmed_at = datetime('now'), totp_last_counter = ?, updated_at = datetime('now') WHERE id = ?",
      [result.counter, userId],
    );
    // A re-enrollment must not leave the previous set usable.
    db.run("DELETE FROM user_recovery_codes WHERE user_id = ?", [userId]);
    for (const c of codes) {
      db.run("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)", [
        userId,
        hashRecoveryCode(c),
      ]);
    }
  })();

  return { recovery_codes: codes };
}

export async function disableTwoFactor(userId: string, password: string): Promise<boolean> {
  const db = getDb();
  const user = getUser(userId);
  if (!user) return false;

  // Re-authenticate: a walk-up attacker on an unlocked session must not be
  // able to strip the second factor.
  if (!(await verifyPassword(password, user.password_hash))) return false;

  db.transaction(() => {
    db.run(
      "UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL, totp_last_counter = NULL, updated_at = datetime('now') WHERE id = ?",
      [userId],
    );
    db.run("DELETE FROM user_recovery_codes WHERE user_id = ?", [userId]);
  })();
  return true;
}

export type SecondFactorResult = "ok" | "invalid" | "replay";

/** Accepts either a live authenticator code or one unused recovery code. */
export function verifySecondFactor(userId: string, code: string): SecondFactorResult {
  const db = getDb();
  const user = getUser(userId);
  if (!user?.totp_secret || !user.totp_enabled) return "invalid";

  const result = verifyTotp(user.totp_secret, code);
  if (result.valid && result.counter !== null) {
    // Each 30-second code is single-use, so a shoulder-surfed or intercepted
    // code is worthless once it has been spent.
    if (user.totp_last_counter !== null && result.counter <= user.totp_last_counter) {
      return "replay";
    }
    db.run("UPDATE users SET totp_last_counter = ? WHERE id = ?", [result.counter, userId]);
    return "ok";
  }

  const hash = hashRecoveryCode(code);
  const row = db
    .query(
      "SELECT id FROM user_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    )
    .get(userId, hash) as { id: string } | null;
  if (row) {
    db.run("UPDATE user_recovery_codes SET used_at = datetime('now') WHERE id = ?", [row.id]);
    return "ok";
  }

  return "invalid";
}

export function createChallenge(userId: string, tenantId?: string): string {
  const db = getDb();
  const token = crypto.randomBytes(32).toString("hex");
  db.run("INSERT INTO mfa_challenges (token, user_id, tenant_id, expires_at) VALUES (?, ?, ?, ?)", [
    token,
    userId,
    tenantId ?? null,
    new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  ]);
  // Opportunistic cleanup — no scheduler entry needed for a tiny table.
  db.run("DELETE FROM mfa_challenges WHERE expires_at < datetime('now', '-1 day')");
  return token;
}

/**
 * Resolves a challenge without spending it, so a mistyped code doesn't force
 * the user back to the password step. Spend it with `consumeChallenge` only
 * once the second factor actually verified.
 */
export function peekChallenge(token: string): { user_id: string; tenant_id: string | null } | null {
  const row = getDb()
    .query("SELECT user_id, tenant_id, expires_at, consumed_at FROM mfa_challenges WHERE token = ?")
    .get(token) as {
    user_id: string;
    tenant_id: string | null;
    expires_at: string;
    consumed_at: string | null;
  } | null;

  if (!row || row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { user_id: row.user_id, tenant_id: row.tenant_id };
}

export function consumeChallenge(token: string): void {
  getDb().run("UPDATE mfa_challenges SET consumed_at = datetime('now') WHERE token = ?", [token]);
}
