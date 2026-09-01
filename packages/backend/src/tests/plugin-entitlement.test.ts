import { afterEach, describe, expect, test } from "bun:test";
import { getPluginEntitlementCheck, setPluginEntitlementCheck } from "../plugins/entitlement";

afterEach(() => setPluginEntitlementCheck(null));

describe("plugin entitlement seam", () => {
  test("defaults to none installed, so OSS treats everything as entitled", () => {
    expect(getPluginEntitlementCheck()).toBeNull();
  });

  test("an installed resolver is returned and consulted", () => {
    setPluginEntitlementCheck((feature) => feature === "peppol");
    const check = getPluginEntitlementCheck();
    expect(check).not.toBeNull();
    expect(check?.("peppol")).toBe(true);
    expect(check?.("france")).toBe(false);
  });

  test("passing null uninstalls it", () => {
    setPluginEntitlementCheck(() => true);
    setPluginEntitlementCheck(null);
    expect(getPluginEntitlementCheck()).toBeNull();
  });
});
