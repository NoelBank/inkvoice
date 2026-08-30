// Frontend plugin framework barrel. Imported by @/registrations at bootstrap
// (before <App> renders). Installs the nav gate, registers the admin Plugins
// settings tab, and side-effect-imports each official plugin's frontend
// module (which registers its own nav item, route, i18n, and registry
// metadata).
//
// To add a plugin: create plugins/<id>/index.tsx and add a side-effect import.

import { registerSettingsTab } from "@/pages/settings-tab-registry";
import "./i18n";
import { installPluginNavGate } from "./install-nav-gate";
import { PluginsSettingsTab } from "./PluginsSettingsTab";

// Official plugins, each registering its surface on import.
// import "./time-tracker"; // added in Task 8

installPluginNavGate();

registerSettingsTab({
  id: "plugins",
  label: "plugins.tab",
  content: <PluginsSettingsTab />,
  hideSave: true,
});
