#!/usr/bin/env bun
// Refreshes the bundled plugin catalog snapshot from the published catalog.
//
//   bun run sync:catalog           fetch and write
//   bun run sync:catalog --check   exit 1 if the committed snapshot is behind
//
// The snapshot at packages/backend/src/plugins/catalog-snapshot.json is what an
// air-gapped install, or one whose fetch is failing, renders. It used to be
// maintained by hand alongside two other copies of the same data (the marketing
// site's committed catalog, and the published artifact itself) with nothing
// checking that the three agreed. This makes updating it one command and makes
// the drift detectable in CI.
//
// generated_at is preserved and a move in it alone is not a rewrite: it changes
// on every upstream build, but dropping it left the Plugins tab able to report
// only when it last fetched, which reads as freshness over data of any age.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CATALOG_URL = "https://inkvoice.app/plugins/catalog.v1.json";
export const SNAPSHOT_PATH = path.resolve(
  import.meta.dir,
  "..",
  "packages",
  "backend",
  "src",
  "plugins",
  "catalog-snapshot.json",
);

export function validateCatalog(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("catalog payload is not an object");
  }
  const v = payload as Record<string, unknown>;
  if (v.schema !== 1) {
    throw new Error(`unsupported catalog schema: ${String(v.schema)} (expected 1)`);
  }
  if (!Array.isArray(v.plugins) || v.plugins.length === 0) {
    throw new Error("catalog payload has an empty or missing plugins array");
  }
  return v;
}

export function serialize(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function contentOf(serialized: string): string {
  try {
    const { generated_at: _ignored, ...rest } = JSON.parse(serialized) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return serialized;
  }
}

function hasTimestamp(serialized: string): boolean {
  try {
    return typeof (JSON.parse(serialized) as { generated_at?: unknown }).generated_at === "string";
  } catch {
    return false;
  }
}

export function isUpToDate(prev: string, next: string): boolean {
  if (contentOf(prev) !== contentOf(next)) return false;
  return !hasTimestamp(next) || hasTimestamp(prev);
}

export async function runSync(
  opts: { snapshotPath?: string; fetchImpl?: typeof fetch; check?: boolean } = {},
): Promise<"written" | "unchanged" | "behind"> {
  const snapshotPath = opts.snapshotPath ?? SNAPSHOT_PATH;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(CATALOG_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const next = serialize(validateCatalog(await res.json()));
  const prev = await readFile(snapshotPath, "utf8").catch(() => null);
  if (prev !== null && isUpToDate(prev, next)) return "unchanged";
  if (opts.check) return "behind";
  await writeFile(snapshotPath, next);
  return "written";
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  runSync({ check })
    .then((result) => {
      if (result === "behind") {
        console.error(
          "✗ sync-catalog: the bundled snapshot is behind the published catalog. Run `bun run sync:catalog` and commit the result.",
        );
        process.exit(1);
      }
      console.log(
        result === "written" ? "  ✓ catalog-snapshot.json" : "  · snapshot unchanged, nothing to write",
      );
    })
    .catch((err) => {
      console.error("✗ sync-catalog failed:", (err as Error).message);
      process.exit(1);
    });
}
