import type { Context, Next } from "hono";
import { getPluginFeatureGate } from "./feature-gate";
import type { BackendPlugin } from "./registry";
import { isPluginEnabled } from "./settings";

/**
 * Access gate for a plugin's routes, mounted at /api/v1/plugins/<id>/* after
 * the core auth middleware, so user context is already resolved. A disabled
 * plugin answers 404 (it should look non-existent). When the plugin declares a
 * plan feature and an overlay installed a policy gate, that gate runs too.
 */
export function pluginGate(plugin: BackendPlugin) {
  return async (c: Context, next: Next) => {
    if (!isPluginEnabled(plugin.id)) {
      return c.json({ success: false, error: "Plugin not enabled", plugin: plugin.id }, 404);
    }
    if (plugin.feature) {
      const gate = getPluginFeatureGate();
      if (gate) return gate(plugin.feature)(c, next);
    }
    await next();
  };
}
