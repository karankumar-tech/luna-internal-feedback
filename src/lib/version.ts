/**
 * App and firmware versions compared as dotted numbers, so 1.10 is newer than 1.9.
 *
 * Only the leading dotted number is read: "v2.4.0", "2.4.0-beta" and "2.4.0 (312)" are all 2.4.0.
 * Anything without one ("dev", "", null) is unreadable, and an unreadable version never compares.
 */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const m = /^\s*v?(\d{1,9}(?:\.\d{1,9}){0,5})/i.exec(v);
  if (!m) return null;
  return m[1]!.split('.').map(Number);
}

/** Negative when a < b, 0 when equal, positive when a > b; null when either is unreadable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when `v` is readable and at least `min`. */
export function isAtLeast(v: string | null | undefined, min: string | null | undefined): boolean {
  const c = compareVersions(v, min);
  return c !== null && c >= 0;
}

/** The oldest readable version in a list, or null. */
export function oldestVersion(versions: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!parseVersion(v)) continue;
    if (best === null || compareVersions(v, best)! < 0) best = v!;
  }
  return best;
}
