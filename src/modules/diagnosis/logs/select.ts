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
 * For one source, pick the files worth downloading for an issue on `occurredOn`:
 * uploads dated occurredOn-1 … occurredOn+2, nearest to occurredOn first, at most `max`.
 * Undated files (no date in path) come last and only if nothing else qualifies.
 */
export function pickFiles(files: LogFileRef[], occurredOn: string, max = 3): LogFileRef[] {
  const dated = files
    .filter((f) => f.date)
    .map((f) => ({ f, d: dayDiff(f.date!, occurredOn) }))
    .filter(({ d }) => d >= -1 && d <= 2)
    .sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || b.d - a.d);
  const picked = dated.slice(0, max).map(({ f }) => f);
  if (picked.length === 0) {
    const undated = files.filter((f) => !f.date);
    return undated.slice(0, 1);
  }
  return picked;
}

export function pickAllSources(entry: LogDeviceEntry, occurredOn: string): Record<LogSource, LogFileRef[]> {
  return {
    app: pickFiles(entry.files.app, occurredOn),
    ring: pickFiles(entry.files.ring, occurredOn, 2),
    firmware: pickFiles(entry.files.firmware, occurredOn),
  };
}
