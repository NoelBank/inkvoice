// Frontend plugin registry. Holds display metadata for the Plugins management
// tab. A plugin's actual surface (nav items, routes, i18n) is wired straight
// into the OSS registries by the plugin's own module; this registry only tracks
// what to show in the admin Plugins list so future plugins drop in by adding
// one registerPlugin() call.

import type { ComponentType } from "react";

export interface FrontendPlugin {
  /** Must match the backend plugin id and the route's pluginId. */
  id: string;
  /** i18n key for the display name (e.g. "time_tracker.name"). */
  nameKey: string;
  /** i18n key for the short description. */
  descriptionKey: string;
  /** Icon shown in the Plugins list. */
  icon: ComponentType<{ className?: string }>;
}

const PLUGINS: FrontendPlugin[] = [];

export function registerPlugin(plugin: FrontendPlugin): void {
  const idx = PLUGINS.findIndex((p) => p.id === plugin.id);
  if (idx >= 0) PLUGINS.splice(idx, 1);
  PLUGINS.push(plugin);
}

export function getPlugins(): FrontendPlugin[] {
  return PLUGINS;
}
