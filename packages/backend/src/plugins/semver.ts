// Strict MAJOR.MINOR.PATCH comparison. The catalog schema forbids prerelease
// and build metadata, so this deliberately handles nothing else and takes no
// dependency. Inputs are assumed to have already matched the catalog's semver
// pattern; malformed input compares as 0.

export function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when a is strictly newer than b. */
export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

/** True when a is at least b. Used for "does this app satisfy min_app". */
export function gte(a: string, b: string): boolean {
  return compare(a, b) >= 0;
}
