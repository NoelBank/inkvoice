import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "../database/connection";
import type { Action, Resource } from "../types/user";
import { CURRENT_JWT_VERSION, type JWTPayload, verifyToken } from "../utils/jwt";
import { roleAllows } from "../utils/permissions";

declare module "hono" {
  interface ContextVariableMap {
    user: JWTPayload;
    userId: string;
    /** Set by a multi-tenant overlay's middleware. Undefined standalone. */
    tenant?: { id: string; slug: string; status: string; plan: string };
  }
}

export async function authMiddleware(c: Context, next: Next) {
  let token: string | undefined;

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  if (!token) {
    token = getCookie(c, "session") || undefined;
  }

  if (!token) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  let payload: JWTPayload;
  try {
    payload = await verifyToken(token);
  } catch {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }

  // Reject pre-versioning tokens — forces a one-time re-login on rollout.
  // Tokens missing `v` are pre-T1.4; current code always issues v=1+.
  if (typeof payload.v !== "number" || payload.v < CURRENT_JWT_VERSION) {
    return c.json({ success: false, error: "Token expired (please log in again)" }, 401);
  }

  // Cross-tenant binding: a token issued for tenant A must not be honored on
  // tenant B's subdomain. Only enforced when a tenant is on the request
  // context (multi-tenant overlay); standalone requests resolve no tenant.
  const tenant = c.get("tenant") as { id: string } | undefined;
  if (tenant) {
    if (!payload.tenant_id || payload.tenant_id !== tenant.id) {
      return c.json({ success: false, error: "Token does not match tenant" }, 401);
    }
  }

  // Verify user is still active in the resolved DB.
  const db = getDb();
  const activeUser = db
    .query("SELECT is_active FROM users WHERE id = ? AND is_active = 1")
    .get(payload.sub);
  if (!activeUser) {
    return c.json({ success: false, error: "Account deactivated" }, 401);
  }

  c.set("user", payload);
  c.set("userId", payload.sub);
  await next();
}

export function requirePermission(resource: Resource, action: Action) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");

    // Admin / Owner short-circuit.
    if (user.is_admin) {
      await next();
      return;
    }

    const db = getDb();

    // Prefer role-based check (post-T2.11). Falls back to legacy
    // user_permissions row check for tenants/users that haven't migrated yet.
    const userRow = db.query("SELECT role FROM users WHERE id = ?").get(user.sub) as {
      role: string | null;
    } | null;

    if (userRow?.role && roleAllows(userRow.role, resource, action)) {
      await next();
      return;
    }

    const perm = db
      .query("SELECT id FROM user_permissions WHERE user_id = ? AND resource = ? AND action = ?")
      .get(user.sub, resource, action);

    if (!perm) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    await next();
  };
}
