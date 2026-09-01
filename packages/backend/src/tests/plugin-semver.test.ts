import { describe, expect, test } from "bun:test";
import { compare, gt, gte } from "../plugins/semver";

describe("plugin semver", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compare("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compare("1.2.0", "1.3.0")).toBeLessThan(0);
    expect(compare("1.0.2", "1.0.3")).toBeLessThan(0);
  });

  test("compares numerically, not lexically", () => {
    expect(compare("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compare("0.10.0", "0.2.0")).toBeGreaterThan(0);
  });

  test("treats equal versions as equal", () => {
    expect(compare("1.2.3", "1.2.3")).toBe(0);
  });

  test("gt is strict", () => {
    expect(gt("1.1.0", "1.0.0")).toBe(true);
    expect(gt("1.0.0", "1.0.0")).toBe(false);
    expect(gt("1.0.0", "1.1.0")).toBe(false);
  });

  test("gte allows equality", () => {
    expect(gte("1.0.0", "1.0.0")).toBe(true);
    expect(gte("1.1.0", "1.0.0")).toBe(true);
    expect(gte("0.9.0", "1.0.0")).toBe(false);
  });

  test("the app-version comparison the update badge depends on", () => {
    // APP_VERSION 0.2.0 against a plugin release needing 0.3.0.
    expect(gte("0.2.0", "0.3.0")).toBe(false);
    expect(gte("0.3.0", "0.3.0")).toBe(true);
  });
});
