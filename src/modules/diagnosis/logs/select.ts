import type { LogDeviceEntry, LogFileRef, LogSource } from './types.js';

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Choose the device entry most likely to hold the issue's logs:
 * same platform first, then the entry whose last upload is on/after the issue day (closest wins),
 * else the most recently updated one.
 */
export function pickEntry(entries: LogDeviceEntry[], opts: { platform?: string | null; occurredOn: string }): LogDeviceEntry | null {
  if (entries.length === 0) return null;
  const withScore = entries.map((e) => {
    const samePlatform = opts.platform && e.platform ? e.platform === opts.platform.toLowerCase() : false;
    const updatedDay = e.updated_at ? e.updated_at.slice(0, 10) : null;
    const diff = updatedDay ? dayDiff(updatedDay, opts.occurredOn) : null; // >= 0 means uploaded after the issue
    const fileCount = e.files.app.length + e.files.ring.length + e.files.firmware.length;
    let score = 0;
    if (samePlatform) score += 100;
    if (diff !== null) score += diff >= 0 ? 50 - Math.min(diff, 30) : 20 - Math.min(-diff, 20);
    score += Math.min(fileCount, 10);
    return { e, score };
  });
  withScore.sort((a, b) => b.score - a.score);
  return withScore[0]!.e;
}

/**
 * For one source, pick the single upload most likely to contain the issue: the earliest file dated on or
 * after the issue day (uploads happen after the day's events; up to +2 days), else the latest file from
 * the day before. Undated files (no date in the path) are used only when nothing else qualifies.
 * One file per source keeps downloads and model input small; more files rarely add signal.
 */
export function pickFiles(files: LogFileRef[], occurredOn: string, max = 1): LogFileRef[] {
  const dated = files.filter((f) => f.date).map((f) => ({ f, d: dayDiff(f.date!, occurredOn) }));
  const after = dated.filter(({ d }) => d >= 0 && d <= 2).sort((a, b) => a.d - b.d);
  const before = dated.filter(({ d }) => d === -1);
  const picked = [...after, ...before].slice(0, max).map(({ f }) => f);
  if (picked.length === 0) return files.filter((f) => !f.date).slice(0, 1);
  return picked;
}

export function pickAllSources(entry: LogDeviceEntry, occurredOn: string): Record<LogSource, LogFileRef[]> {
  return {
    app: pickFiles(entry.files.app, occurredOn),
    ring: pickFiles(entry.files.ring, occurredOn),
    firmware: pickFiles(entry.files.firmware, occurredOn),
  };
}
