// Time Tracker frontend registration. On import it wires the plugin's surface
// into the OSS registries: a protected route (guarded by PluginGuard), a
// sidebar nav item under the Extensions section, its i18n, and its display
// metadata for the admin Plugins tab.

import { Clock } from "lucide-react";
import { registerNavItem } from "@/nav-registry";
import { registerRoute } from "@/route-registry";
import { PluginGuard } from "../PluginGuard";
import { registerPlugin } from "../registry";
import "./i18n";
import TimeTrackingPage from "./TimeTrackingPage";

const PLUGIN_ID = "time-tracker";

registerRoute({
  path: "/time-tracking",
  element: (
    <PluginGuard pluginId={PLUGIN_ID}>
      <TimeTrackingPage />
    </PluginGuard>
  ),
  scope: "protected",
});

registerNavItem({
  to: "/time-tracking",
  labelKey: "time_tracker.nav",
  icon: Clock,
  section: "nav.extensions",
  pluginId: PLUGIN_ID,
});

registerPlugin({
  id: PLUGIN_ID,
  nameKey: "time_tracker.name",
  descriptionKey: "time_tracker.description",
  icon: Clock,
});
