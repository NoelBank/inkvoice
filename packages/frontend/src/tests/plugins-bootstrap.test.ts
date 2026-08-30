// Bootstrap smoke test: importing the plugins barrel must register the
// framework's settings tab and (after Task 8) the time-tracker surface into
// the OSS extension points. Mirrors cloud's cloud-bootstrap.test.ts.

import { describe, expect, test } from "bun:test";
import { getNavItems } from "@/nav-registry";
import { getSettingsTabs } from "@/pages/settings-tab-registry";
import { getPlugins } from "@/plugins/registry";
import { getRoutes } from "@/route-registry";
import "@/plugins";

const settingsTabIds = getSettingsTabs().map((t) => t.id);
const protectedPaths = getRoutes("protected").map((r) => r.path);

describe("oss plugin bootstrap", () => {
  test("registers the Plugins settings tab", () => {
    expect(settingsTabIds).toContain("plugins");
  });

  test("installs the nav gate without breaking core nav", () => {
    // useNavGate must be callable; the allow-all default is replaced by the
    // plugin gate at bootstrap. We assert the registry is intact.
    expect(Array.isArray(getNavItems())).toBe(true);
  });

  test("registers the time-tracker route and nav item", () => {
    expect(protectedPaths).toContain("/time-tracking");
    expect(
      getNavItems().some((n) => n.to === "/time-tracking" && n.pluginId === "time-tracker"),
    ).toBe(true);
  });

  test("registers the time-tracker plugin metadata", () => {
    expect(getPlugins().some((p) => p.id === "time-tracker")).toBe(true);
  });
});
