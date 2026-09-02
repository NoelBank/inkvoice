// The catalog validates icon names against the lucide versions its consumers
// run, but both consumers resolve an icon through a small curated map and fall
// back to a puzzle piece. That made the upstream guard admit roughly a thousand
// names this app would draw as a fallback, silently. This is the local half of
// the fix: whatever catalog this build ships, it must be able to draw all of it.

import { describe, expect, test } from "bun:test";
import snapshot from "../../../backend/src/plugins/catalog-snapshot.json";
import { catalogIcon, KNOWN_ICONS } from "../plugins/icon-map";

interface Entry {
  id: string;
  icon: string;
}

describe("catalog icons", () => {
  test("every icon in the bundled snapshot resolves to a real icon", () => {
    const entries = snapshot.plugins as Entry[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect({ id: entry.id, known: KNOWN_ICONS.has(entry.icon) }).toEqual({
        id: entry.id,
        known: true,
      });
    }
  });

  test("an unmapped name still falls back rather than throwing", () => {
    expect(catalogIcon("NotAnIconWeMap")).toBeDefined();
  });
});
