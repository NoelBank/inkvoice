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
