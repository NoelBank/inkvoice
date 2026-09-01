import { describe, expect, test } from "bun:test";
import type { CatalogPlugin } from "../plugins/catalog.service";
import { mergePlugins } from "../plugins/merge";

function entry(over: Partial<CatalogPlugin> = {}): CatalogPlugin {
  return {
    id: "time-tracker",
    name: "Time Tracker",
    tagline: "Track billable hours.",
    description: "Body.",
    category: "productivity",
    status: "available",
    availability: "both",
    requires_feature: null,
    icon: "Clock",
    docs: "https://example.com/docs",
    source: null,
    screenshots: [],
    latest: { version: "1.0.0", min_app: "0.2.0", released: "2026-06-08" },
    versions: [{ version: "1.0.0", min_app: "0.2.0", released: "2026-06-08" }],
    ...over,
  };
}

const base = {
  appVersion: "0.2.0",
  votes: {},
  isEntitled: () => true,
};

const installed = (id: string, version: string, enabled: boolean) => ({
  id,
  version,
  enabled,
});

describe("mergePlugins", () => {
  test("an installed, enabled, current plugin has no blocker and no update", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry()],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(p!.installed).toBe(true);
    expect(p!.enabled).toBe(true);
    expect(p!.installedVersion).toBe("1.0.0");
    expect(p!.latestVersion).toBe("1.0.0");
    expect(p!.updateAvailable).toBe(false);
    expect(p!.blockedReason).toBeNull();
  });

  test("a newer catalog version sets updateAvailable", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ latest: { version: "1.1.0", min_app: "0.2.0", released: "2026-09-01" } })],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(p!.updateAvailable).toBe(true);
    expect(p!.latestVersion).toBe("1.1.0");
    expect(p!.updateRequiresApp).toBeNull();
  });

  test("updateRequiresApp is set only when the app is below the release's min_app", () => {
    const needs03 = entry({
      latest: { version: "1.1.0", min_app: "0.3.0", released: "2026-09-01" },
    });
    const [below] = mergePlugins({
      ...base,
      catalog: [needs03],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(below!.updateRequiresApp).toBe("0.3.0");

    const [above] = mergePlugins({
      ...base,
      appVersion: "0.3.0",
      catalog: [needs03],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(above!.updateRequiresApp).toBeNull();
  });

  test("needing a newer app does not block enabling what is already installed", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ latest: { version: "1.1.0", min_app: "0.3.0", released: "2026-09-01" } })],
      installed: [installed("time-tracker", "1.0.0", false)],
    });
    expect(p!.updateRequiresApp).toBe("0.3.0");
    expect(p!.blockedReason).toBeNull();
  });

  test("a cloud-only entry this build lacks is blocked as cloud_only", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ id: "peppol", availability: "cloud", requires_feature: "peppol" })],
      installed: [],
    });
    expect(p!.installed).toBe(false);
    expect(p!.blockedReason).toBe("cloud_only");
  });

  test("an installed plan-gated plugin is blocked only when the resolver denies", () => {
    const gated = entry({ id: "peppol", availability: "cloud", requires_feature: "peppol" });
    const [denied] = mergePlugins({
      ...base,
      isEntitled: () => false,
      catalog: [gated],
      installed: [installed("peppol", "1.0.0", false)],
    });
    expect(denied!.blockedReason).toBe("requires_feature");

    const [allowed] = mergePlugins({
      ...base,
      isEntitled: (f) => f === "peppol",
      catalog: [gated],
      installed: [installed("peppol", "1.0.0", false)],
    });
    expect(allowed!.blockedReason).toBeNull();
  });

  test("a planned entry is blocked as planned and carries its vote count", () => {
    const [p] = mergePlugins({
      ...base,
      votes: { "accounts-payable": 12 },
      catalog: [entry({ id: "accounts-payable", status: "planned", latest: null, versions: [] })],
      installed: [],
    });
    expect(p!.blockedReason).toBe("planned");
    expect(p!.votes).toBe(12);
    expect(p!.latestVersion).toBeNull();
    expect(p!.installed).toBe(false);
  });

  test("an oss entry this build does not ship asks for an app upgrade", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry({ id: "future-plugin", availability: "both" })],
      installed: [],
    });
    expect(p!.blockedReason).toBe("requires_app_upgrade");
  });

  test("a registry-only plugin absent from the catalog still appears", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [],
      installed: [installed("my-fork-plugin", "3.1.4", true)],
    });
    expect(p!.id).toBe("my-fork-plugin");
    expect(p!.installed).toBe(true);
    expect(p!.enabled).toBe(true);
    expect(p!.installedVersion).toBe("3.1.4");
    expect(p!.latestVersion).toBeNull();
    expect(p!.updateAvailable).toBe(false);
    expect(p!.blockedReason).toBeNull();
    expect(p!.name).toBe("my-fork-plugin");
  });

  test("results are sorted by id so the payload is stable", () => {
    const merged = mergePlugins({
      ...base,
      catalog: [entry({ id: "zeta" }), entry({ id: "alpha" })],
      installed: [installed("mid", "1.0.0", false)],
    });
    expect(merged.map((p) => p.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("votes default to zero when absent", () => {
    const [p] = mergePlugins({
      ...base,
      catalog: [entry()],
      installed: [installed("time-tracker", "1.0.0", true)],
    });
    expect(p!.votes).toBe(0);
  });
});
