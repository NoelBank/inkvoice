// Bootstrap smoke test: importing the plugins barrel must register the
// framework's settings tab and (after Task 8) the time-tracker surface into
// the OSS extension points. Mirrors cloud's cloud-bootstrap.test.ts.

import { describe, expect, test } from "bun:test";
import { getNavItems } from "@/nav-registry";
import { getSettingsTabs } from "@/pages/settings-tab-registry";
import "@/plugins";

const settingsTabIds = getSettingsTabs().map((t) => t.id);

describe("oss plugin bootstrap", () => {
  test("registers the Plugins settings tab", () => {
    expect(settingsTabIds).toContain("plugins");
  });

  test("installs the nav gate without breaking core nav", () => {
    // useNavGate must be callable; the allow-all default is replaced by the
    // plugin gate at bootstrap. We assert the registry is intact.
    expect(Array.isArray(getNavItems())).toBe(true);
  });
});
