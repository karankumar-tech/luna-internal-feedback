import { isAtLeast, oldestVersion } from '../../lib/version.js';
import type { SkewRow } from './kinds.repo.js';

/**
 * Spikes: the last `recent_days` against the daily average of the `prior_days` before them.
 * Flagged at `factor`× that average and at least `min_reports` reports. Nothing before counts as
 * an average of zero, so a new problem with `min_reports` reports in three days is a spike.
 */
export const SPIKE = { recent_days: 3, prior_days: 14, factor: 3, min_reports: 3 } as const;

/** The same ring (or, without a serial, the same person) with this many problem reports in this many days. */
export const REPEAT = { days: 14, min_reports: 3 } as const;

/** A regression stays on the attention page this long, unless the problem is marked fixed again. */
export const REGRESSION_RECENT_DAYS = 14;

/** Version skew is only called out from this many reports, at this many times the baseline share. */
export const SKEW = { min_reports: 3, notable_ratio: 1.5 } as const;

export function isSpike(recent: number, prior: number): boolean {
  if (recent < SPIKE.min_reports) return false;
  const expected = (prior / SPIKE.prior_days) * SPIKE.recent_days;
  return recent >= SPIKE.factor * expected;
}

/** recent ÷ what the prior average predicts for the same number of days; null when there was nothing before. */
export function spikeRatio(recent: number, prior: number): number | null {
  if (!prior) return null;
  return Math.round((recent / ((prior / SPIKE.prior_days) * SPIKE.recent_days)) * 10) / 10;
}

export interface FixVersions { fixed_in_app_version: string | null; fixed_in_firmware_version: string | null }
export interface RanVersions { app_version: string | null; firmware_version: string | null }

/**
 * Is this report a regression of a fixed problem? Every fix version that is set must be met by the
 * report: a report whose version is missing or unreadable is never flagged, so a false alarm needs
 * a real version number to be wrong.
 */
export function regressionVerdict(fix: FixVersions, ran: RanVersions): { reason: string } | null {
  const parts: string[] = [];
  if (fix.fixed_in_app_version) {
    if (!isAtLeast(ran.app_version, fix.fixed_in_app_version)) return null;
    parts.push(`app ${ran.app_version} (fixed in ${fix.fixed_in_app_version})`);
  }
  if (fix.fixed_in_firmware_version) {
    if (!isAtLeast(ran.firmware_version, fix.fixed_in_firmware_version)) return null;
    parts.push(`firmware ${ran.firmware_version} (fixed in ${fix.fixed_in_firmware_version})`);
  }
  if (!parts.length) return null;
  return { reason: `Reported on ${parts.join(' and ')}` };
}

export const SKEW_DIMS = ['firmware', 'app', 'os', 'platform'] as const;

export interface SkewValue {
  value: string;
  kind_count: number;
  base_count: number;
  /** Share of this problem's reports (with a known value) that have this value. */
  kind_share: number;
  /** The same share among all problem reports in the slice. */
  base_share: number;
  /** kind_share ÷ base_share: 2.7 means this value is 2.7 times as common in this problem. */
  ratio: number | null;
  notable: boolean;
}

export interface SkewDim { dim: (typeof SKEW_DIMS)[number]; kind_known: number; base_known: number; values: SkewValue[] }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Shares and ratios per dimension, the top values by count, and the single strongest skew worth a headline. */
export function summarizeSkew(rows: SkewRow[], limit = 6): { dims: SkewDim[]; headline: (SkewValue & { dim: SkewDim['dim'] }) | null } {
  const dims: SkewDim[] = SKEW_DIMS.map((dim) => {
    const rs = rows.filter((r) => r.dim === dim);
    const kindKnown = rs.reduce((n, r) => n + r.kind_count, 0);
    const baseKnown = rs.reduce((n, r) => n + r.base_count, 0);
    const values = rs.filter((r) => r.kind_count > 0).map((r): SkewValue => {
      const kindShare = kindKnown ? r.kind_count / kindKnown : 0;
      const baseShare = baseKnown ? r.base_count / baseKnown : 0;
      const ratio = baseShare ? round2(kindShare / baseShare) : null;
      return {
        value: r.value, kind_count: r.kind_count, base_count: r.base_count,
        kind_share: round2(kindShare), base_share: round2(baseShare), ratio,
        notable: kindKnown >= SKEW.min_reports && r.kind_count >= 2 && ratio !== null && ratio >= SKEW.notable_ratio,
      };
    }).sort((a, b) => b.kind_count - a.kind_count || (b.ratio ?? 0) - (a.ratio ?? 0) || a.value.localeCompare(b.value));
    return { dim, kind_known: kindKnown, base_known: baseKnown, values: values.slice(0, limit) };
  });

  let headline: (SkewValue & { dim: SkewDim['dim'] }) | null = null;
  for (const d of dims) {
    for (const v of d.values) {
      if (!v.notable) continue;
      // Most of the problem's reports, and the most over-represented of those.
      if (v.kind_share < 0.4) continue;
      if (!headline || (v.ratio ?? 0) > (headline.ratio ?? 0)) headline = { ...v, dim: d.dim };
    }
  }
  return { dims, headline };
}

/** The oldest firmware, and the oldest app version per platform, a problem was reported on. */
export function oldestVersions(seen: { platform: string | null; app_version: string | null; firmware_version: string | null }[]) {
  const platforms = [...new Set(seen.map((s) => s.platform ?? ''))];
  return {
    firmware: oldestVersion(seen.map((s) => s.firmware_version)),
    app: platforms
      .map((p) => ({ platform: p || null, version: oldestVersion(seen.filter((s) => (s.platform ?? '') === p).map((s) => s.app_version)) }))
      .filter((x): x is { platform: string | null; version: string } => x.version !== null),
  };
}
