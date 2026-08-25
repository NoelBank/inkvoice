import { getDb } from "../database/connection";
import type { User } from "../types/user";
import { signToken } from "../utils/jwt";
import { verifyPassword } from "../utils/password";

export interface SessionResult {
  token: string;
  user: {
    id: string;
    username: string;
    email: string | null;
    display_name: string | null;
    is_admin: boolean;
    role: string | null;
  };
}

/** Password was correct, but the account carries a second factor. */
export interface MfaRequired {
  mfa_required: true;
  user_id: string;
}

export type LoginResult = SessionResult | MfaRequired | null;

export function isMfaRequired(result: LoginResult): result is MfaRequired {
  return result !== null && "mfa_required" in result;
}

/** Mints the session token for an already-authenticated user. */
export async function issueSession(
  user: Pick<User, "id" | "username" | "email" | "display_name" | "is_admin" | "role">,
  tenantId?: string,
): Promise<SessionResult> {
  const token = await signToken({
    sub: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    tenant_id: tenantId,
  });

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      is_admin: !!user.is_admin,
      role: user.role ?? null,
    },
  };
}

export async function issueSessionForUserId(
  userId: string,
  tenantId?: string,
): Promise<SessionResult | null> {
  const db = getDb();
  const user = db
    .query("SELECT * FROM users WHERE id = ? AND is_active = 1")
    .get(userId) as User | null;
  if (!user) return null;
  return issueSession(user, tenantId);
}

export async function login(
  username: string,
  password: string,
  tenantId?: string,
): Promise<LoginResult> {
  const db = getDb();
  const user = db.query("SELECT * FROM users WHERE username = ? AND is_active = 1").get(username) as
    | (User & { totp_enabled?: number; totp_secret?: string | null })
    | null;

  if (!user) {
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return null;
  }

  // Stop short of a session: the caller has to clear the second factor first.
  if (user.totp_enabled && user.totp_secret) {
    return { mfa_required: true, user_id: user.id };
  }

  return issueSession(user, tenantId);
}

export function getCurrentUser(userId: string) {
  const db = getDb();
  const user = db
    .query(
      "SELECT id, username, email, display_name, is_admin, role FROM users WHERE id = ? AND is_active = 1",
    )
    .get(userId) as Omit<User, "password_hash" | "is_active" | "created_at" | "updated_at"> | null;

  if (!user) return null;

  const permissions = db
    .query("SELECT resource, action FROM user_permissions WHERE user_id = ?")
    .all(userId) as { resource: string; action: string }[];

  return { ...user, is_admin: !!user.is_admin, permissions };
}
