# OIDC / SSO for self-hosted installs — Design

Date: 2026-08-14
Status: Approved (design review)
Repo: `pigontech/inkvoice` (OSS, MIT)

## Motivation

Generic OIDC single sign-on is the most-requested feature in the open-source
invoicing category. The cloud overlay implements Google/Microsoft/Apple OAuth,
so the session and account-linking plumbing exists there, but the OSS app has
no SSO at all: authentication is username + password against the local `users`
table only.

This feature adds generic OIDC to the OSS app: a configurable issuer with
discovery (`/.well-known/openid-configuration`), authorization code + PKCE
flow, JIT user provisioning, and an SSO button on the login page. It targets
any standard OIDC provider (Keycloak, Authentik, Authelia, Entra ID, Okta,
Google Workspace, …) with zero provider-specific code.

## Decisions (from design review)

| Question | Decision |
|---|---|
| Provisioning | JIT auto-provision as `Viewer` (read-only); optional domain allowlist. Admin promotes via existing Users page. |
| Config surface | Env vars only (same model as SMTP/Stripe/PayPal/Peppol). No settings-table storage, no admin UI. |
| OIDC library | `arctic` (generic `OAuth2Provider`: auth URL, PKCE, code exchange) + `jose` (JWKS + id_token validation). Both deps already ship in `packages/backend/package.json`. Thin discovery layer hand-written (~200 lines), fully unit-testable against a stub server. |
| Password login | Remains enabled and untouched (admin recovery; broken SSO can never strand the admin). |
| Providers | One OIDC provider per instance. No multi-provider support. |

## Configuration

New fields on the `Env` interface in `packages/backend/src/utils/env.ts`.
`OIDC_ISSUER_URL` set (non-empty) ⇒ SSO enabled.

```
OIDC_ISSUER_URL         # e.g. https://auth.company.com/realms/main
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET
OIDC_SCOPE              # default "openid email profile"
OIDC_ALLOWED_DOMAINS    # optional, comma-separated email domains (JIT gate)
OIDC_AUTO_PROVISION     # default "true"
OIDC_PROVIDER_NAME      # optional button label, e.g. "Google Workspace"
```

Issuer URL validation at startup (mirrors `PEPPOL_SH_BASE_URL` handling in
`getEnv`): must parse as a URL, protocol `https:`, no embedded username or
password. A misconfigured issuer fails fast at boot with a FATAL log.

## Routes

New file `packages/backend/src/routes/oidc.ts`, a `Hono` router mounted in
`packages/backend/src/app.ts` as `app.route("/api/v1/auth/oidc", oidc)`
alongside the existing `auth` router (i.e. before `authMiddleware` applies).

### GET /api/v1/auth/oidc/start

1. Rate-limited (`bucketRateLimiter("oidc-start", …)`, same bucket style as
   forgot-password).
2. If SSO disabled (no `OIDC_ISSUER_URL`) → 404 JSON `{ success: false }`.
3. Fetch discovery document from `{issuer}/.well-known/openid-configuration`
   (in-process cache, 1h TTL; pattern matches the cloud's cached Apple JWKS —
   fresh implementation). On failure → 503 `{ success: false, error:
   "OIDC misconfigured" }` (details only in server logs).
4. Build the authorization URL with `arctic.OAuth2Provider(
   authorization_endpoint, token_endpoint, client_id, client_secret, redirect_uri,
   { pkce: "S256" } )` using the discovered endpoints; scopes = `OIDC_SCOPE`.
   Generate `state`, `code_verifier`, and a random `nonce` (32 bytes hex).
5. Write the signed state cookie (see Security) and 302 to the provider URL.

### GET /api/v1/auth/oidc/callback

1. Read `code`, `state` query params and the state cookie. Missing/invalid →
   redirect `/login?oidc_error=invalid_state`. Cookie deleted on every
   callback attempt (single-use).
2. `jose.jwtVerify(id_token, createRemoteJWKSet(discovered jwks_uri), {
   issuer: OIDC_ISSUER_URL, audience: OIDC_CLIENT_ID })` plus an explicit
   `nonce` claim check (jose does not check nonce). Token-endpoint response
   body capped at 1 MB; discovery fetch has a 10 s timeout. Secrets and
   tokens never logged.
3. Extract claims: `sub` (required), `email` (required), `name` (optional),
   `email_verified` (boolean or string "true").
4. Resolve/provision the user (see below) and sign the same session JWT the
   password login signs (`sub`, `username`, `is_admin`, `tenant_id` via
   `signToken`), set the `session` cookie with identical options (httpOnly,
   `COOKIE_SECURE`, SameSite=Strict, `SESSION_TTL`), `logActivity("login")`,
   redirect `/`.
5. All failures redirect to `/login?oidc_error=<code>` — the callback is a
   top-level browser navigation, never raw JSON.

### Redirect URI

`PUBLIC_BASE_URL` (trailing slashes stripped) + `/api/v1/auth/oidc/callback`
if set, otherwise the request origin (`new URL(c.req.url).origin`). Host-
derived is safe here: the provider only honors its registered redirect URI,
and this is the standard behavior for reverse-proxied self-hosted installs.
Admin registers the same URL at the provider.

## Migration (version 26)

`packages/backend/src/database/migrations.ts`:

```sql
ALTER TABLE users ADD COLUMN oidc_issuer TEXT;   -- NULL for password-only users
ALTER TABLE users ADD COLUMN oidc_subject TEXT;
CREATE UNIQUE INDEX idx_users_oidc ON users(oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL;
```

`password_hash` stays `NOT NULL`. JIT-provisioned users receive a random
bcrypt hash (`crypto.randomBytes` → `hashPassword`); they can never log in
with a password, and the schema needs no relaxation.

## Account resolution & provisioning

`services/oidc.service.ts` (new; DB access via `getDb`, prepared statements,
same style as `auth.service.ts`). Resolution order:

1. **Existing SSO identity**: `SELECT … WHERE oidc_issuer = ? AND
   oidc_subject = ? AND is_active = 1` → login.
2. **Verified-email link**: only when the id_token attests
   `email_verified === true`, match an active user with
   `WHERE lower(email) = lower(?)` → stamp `oidc_issuer`/`oidc_subject` on
   that user (keeps username/role), login. Unverified emails are never used
   for matching (nOAuth account-takeover class).
3. **JIT provision** (when all of: `OIDC_AUTO_PROVISION` true, and either
   `OIDC_ALLOWED_DOMAINS` unset or the email domain listed):
   `username = email`, or `email-N` (first free N≥2) if the username is taken
   by a *different* user; `display_name` from the `name` claim; `role =
   'Viewer'`, `is_admin = 0`; random password hash; `oidc_issuer/subject`
   set. JIT does not require `email_verified` — the configured IdP is the
   admin's chosen trust boundary, and `OIDC_ALLOWED_DOMAINS` is the optional
   gate. Activity: `logActivity({ action: "user_created", resource_type:
   "user", resource_id, user_id, user_name })`.
4. **Reject** (with a distinct `oidc_error` code): missing `sub`/`email`;
   unverified email when linking (step 2 inapplicable — JIT still applies per
   step 3 when auto-provision is on); domain not allowed; auto-provision
   disabled; user inactive; SSO disabled.

JIT never grants more than Viewer. Role/promotion changes happen in the
existing Users page.

## Security hardening

- **State cookie** (`utils/oidc-state.ts`, new, original implementation):
  HMAC-SHA256 over a JSON payload `{ state, code_verifier, nonce, iat, exp }`
  with `exp − iat ≤ 600 s`, keyed by `JWT_SECRET`; `httpOnly`, `SameSite=Lax`,
  `secure` per `COOKIE_SECURE`, `path=/`. Any tampering, expiry, or
  verifier/nonce reuse across flows fails validation. Deleted on the callback.
- **id_token**: signature via discovered JWKS, `iss` must equal the configured
  issuer exactly, `aud` must include the client id, `exp` (jose), nonce
  checked manually.
- **PKCE S256** always on (arctic option).
- **SSRF**: issuer https-only + no-credentials enforced at startup; discovery
  fetch timeouts; no user-supplied URL ever fetched.
- **Error surface**: server-side failures return `oidc_error=misconfigured`
  to the user and full details only in server logs.
- **Login-page surface**: only `oidc_enabled` + optional provider name are
  published publicly (nothing about client id/secret/issuer internals).

## Frontend

`packages/frontend/src/pages/Login.tsx`:

- `GET /api/v1/public/config` gains `oidc_enabled: boolean` and
  `oidc_provider_name: string | null` (published from `routes/public.ts`).
  Login.tsx already fetches this endpoint for the demo hint — extend the
  existing effect, fail soft as today.
- When enabled, render an SSO button above the credentials form:
  label = `t("auth.sign_in_with_provider", { provider: name })` when a name
  is configured, else `t("auth.sign_in_with_sso")`. Click navigates to
  `/api/v1/auth/oidc/start`. Rendered directly in Login.tsx (the
  `login-oauth` slot remains overlay-owned).
- `?oidc_error=<code>` on mount → localized banner above the form, mapped
  through the `auth.oidc_error.*` keys (unknown code falls back to
  `auth.oidc_error.auth_failed`).

### i18n

New keys in the `auth` namespace, added to `en.ts` (type source) and
`tr.ts`, `es.ts`, `de.ts`, `fr.ts` (typecheck enforces completeness):

```
auth.sign_in_with_sso       "Sign in with SSO"
auth.sign_in_with_provider  "Sign in with {{provider}}"
auth.sso_or                 "or"  (divider)
auth.oidc_error.invalid_state / auth_failed / email_required /
  unverified_email / domain_not_allowed / provisioning_disabled /
  user_inactive / misconfigured
```

## Docs

- `.env.example`: OIDC block with comments covering discovery, callback URL
  to register at the provider, and JIT/domain semantics.
- `README.md` (or `docs/guide/` index, per existing docs layout): short SSO
  section — supported providers (any standard OIDC), discovery auto-detection,
  PKCE always on, JIT provisioning + `OIDC_ALLOWED_DOMAINS`, account linking
  on verified email, password login unaffected.

## Testing (bun:test, `bun run check` gate)

- **Discovery**: stub HTTP server (bun test fixture) serving a minimal
  `openid-configuration`; cache TTL; https-only enforcement; timeout/size
  handling.
- **State cookie**: tamper, expiry, wrong-secret, verifier reuse rejection.
- **Round-trip** (`start` → `callback`) with an override seam for the
  provider round trip (fresh implementation of the test pattern the cloud
  uses — `setXxxOverride`): existing-identity login; verified-email link;
  unverified-email no-link; JIT create (Viewer, random hash, username
  `email-2` suffix); domain-allowlist reject; `AUTO_PROVISION=false` reject;
  inactive-user reject; wrong `iss`/`aud`/nonce reject; redirect-URI
  construction with and without `PUBLIC_BASE_URL`.

## Cloud interaction (out of scope, noted)

OSS routes live under `/api/v1/auth/oidc/*`. Cloud deployments never set the
OIDC env vars, so the routes 404 — no overlap with the cloud's
`/api/v1/auth/oauth/*` allowlist or routes. If cloud ever wants OSS SSO, its
tenant middleware allowlist would need extending; not part of this feature.

## Out of scope

- Multiple OIDC providers; provider switching / reconfiguration at runtime.
- Forcing SSO-only (disabling password login).
- Cloud Google/Microsoft/Apple flows (unchanged, proprietary).
- SSO signup landing pages, invitations, admin approval workflows.
- `xms_edov`-style extra-claim trust (email_verified is the only trust claim).

## Success criteria

1. Fresh install with a Keycloak/Authentik-compatible issuer: login page shows
   SSO button, first login creates a Viewer user, second login matches the
   identity, admin can promote in Users page.
2. `OIDC_ALLOWED_DOMAINS` and `OIDC_AUTO_PROVISION=false` gate JIT as specified.
3. All backend tests pass; `bun run check` (lint + typecheck + test) green.
4. Password login works exactly as before; no schema loss for existing users.
