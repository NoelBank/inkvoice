// Plugin management API, mounted at /api/v1/plugins (auth-gated by the core
// app). Lists the plugin catalog with this install's enabled state and lets an
// admin toggle plugins. Display metadata (name/description/icon) lives in the
// frontend plugin registry; the backend is the source of truth for enablement.
//
// API tokens: scoped tokens (non-empty scope list) are denied here by
// apiTokenScopeMiddleware because "plugins" is not an API scope resource.
// Unscoped tokens behave as their owner.

import { Hono } from "hono";
import { z } from "zod";
import { APP_VERSION } from "../utils/version";
import { catalogEgressEnabled, getCatalog, getVotes, postVote } from "./catalog.service";
import { getPluginEntitlementCheck } from "./entitlement";
import { mergePlugins } from "./merge";
import { getBackendPlugin, getBackendPlugins } from "./registry";
import { getEnabledPluginIds, setPluginEnabled } from "./settings";

export const pluginsAdminRoutes = new Hono();

// GET /api/v1/plugins: catalog + this install's enabled ids.
pluginsAdminRoutes.get("/", (c) => {
  const enabled = getEnabledPluginIds();
  const plugins = getBackendPlugins().map((p) => ({
    id: p.id,
    feature: p.feature ?? null,
    enabled: enabled.includes(p.id),
  }));
  return c.json({ success: true, data: { plugins, enabled } });
});

const toggleSchema = z.object({ enabled: z.boolean() });

// GET /api/v1/plugins/catalog: the merged view the Plugins tab renders. Any
// authenticated user may read it; only the admin toggle below writes.
pluginsAdminRoutes.get("/catalog", async (c) => {
  const [result, votes] = await Promise.all([getCatalog(), getVotes()]);
  const enabled = getEnabledPluginIds();
  const entitlementCheck = getPluginEntitlementCheck();

  const plugins = mergePlugins({
    catalog: result.catalog.plugins,
    installed: getBackendPlugins().map((p) => ({
      id: p.id,
      version: p.version,
      enabled: enabled.includes(p.id),
    })),
    appVersion: APP_VERSION,
    votes,
    // OSS ships no plans, so with no resolver installed everything is entitled.
    isEntitled: (feature) => (entitlementCheck ? entitlementCheck(feature) : true),
  });

  return c.json({
    success: true,
    data: {
      plugins,
      catalog: {
        source: result.source,
        syncedAt: result.syncedAt,
        error: result.error,
        egressEnabled: catalogEgressEnabled(),
      },
    },
  });
});

// POST /api/v1/plugins/catalog/refresh: force a re-sync, ignoring the TTL.
pluginsAdminRoutes.post("/catalog/refresh", async (c) => {
  const user = c.get("user") as { is_admin?: boolean } | undefined;
  if (!user?.is_admin) return c.json({ success: false, error: "Forbidden" }, 403);

  const result = await getCatalog({ force: true });
  return c.json({
    success: true,
    data: { source: result.source, syncedAt: result.syncedAt, error: result.error },
  });
});

const voteSchema = z.object({ id: z.string().min(1).max(64) });

// POST /api/v1/plugins/catalog/vote: register interest in a planned plugin.
// Proxied so a self-hosted browser never talks to inkvoice.app directly, and so
// clearing plugin_catalog_url disables voting as a consequence.
pluginsAdminRoutes.post("/catalog/vote", async (c) => {
  const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const count = await postVote(parsed.data.id);
  return c.json({ success: true, data: { count } });
});

// PUT /api/v1/plugins/:id: enable/disable a plugin (admin only).
pluginsAdminRoutes.put("/:id", async (c) => {
  const user = c.get("user") as { is_admin?: boolean } | undefined;
  if (!user?.is_admin) return c.json({ success: false, error: "Forbidden" }, 403);

  const id = c.req.param("id");
  if (!getBackendPlugin(id)) {
    return c.json({ success: false, error: "Unknown plugin" }, 404);
  }

  const parsed = toggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  const enabled = setPluginEnabled(id, parsed.data.enabled);
  return c.json({ success: true, data: { enabled } });
});
