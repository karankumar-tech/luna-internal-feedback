import type { LogDeviceEntry, LogFileRef, LogSource } from './types.js';

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The only uploads that can belong to an issue: the day before it, the day itself, and the day
 * after (phones upload the day's logs that evening, or the next day). Nothing outside this is
 * picked for a diagnosis, listed on the ticket, or waited for.
 */
export const LOG_WINDOW_DAYS = { before: 1, after: 1 } as const;

export function logWindow(occurredOn: string): { from: string; to: string } {
  return { from: shiftDay(occurredOn, -LOG_WINDOW_DAYS.before), to: shiftDay(occurredOn, LOG_WINDOW_DAYS.after) };
}

/** Undated uploads are outside by definition: there is no telling which day they hold. */
export function inLogWindow(date: string | null | undefined, occurredOn: string): boolean {
  if (!date) return false;
  const d = dayDiff(date, occurredOn);
  return d >= -LOG_WINDOW_DAYS.before && d <= LOG_WINDOW_DAYS.after;
}

/** A device entry with every file outside the issue window removed. */
export function withinWindow(entry: LogDeviceEntry, occurredOn: string): { entry: LogDeviceEntry; hidden: number } {
  let hidden = 0;
  const keep = (files: LogFileRef[]) => files.filter((f) => (inLogWindow(f.date, occurredOn) ? true : (hidden += 1, false)));
  const files = { app: keep(entry.files.app), ring: keep(entry.files.ring), firmware: keep(entry.files.firmware) };
  return { entry: { ...entry, files }, hidden };
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
 * For one source, pick the single upload most likely to contain the issue, from inside the window only:
 * the issue day's upload, else the next day's (the evening sync often lands after midnight), else the
 * latest from the day before. Anything later, earlier or undated is never used — an old ticket must not
 * be diagnosed from whatever the tester happened to upload last week.
 * One file per source keeps downloads and model input small; more files rarely add signal.
 */
export function pickFiles(files: LogFileRef[], occurredOn: string, max = 1): LogFileRef[] {
  const dated = files.filter((f) => inLogWindow(f.date, occurredOn)).map((f) => ({ f, d: dayDiff(f.date!, occurredOn) }));
  const onOrAfter = dated.filter(({ d }) => d >= 0).sort((a, b) => a.d - b.d);
  const before = dated.filter(({ d }) => d < 0).reverse();
  return [...onOrAfter, ...before].slice(0, max).map(({ f }) => f);
}

export function pickAllSources(entry: LogDeviceEntry, occurredOn: string): Record<LogSource, LogFileRef[]> {
  return {
    app: pickFiles(entry.files.app, occurredOn),
    ring: pickFiles(entry.files.ring, occurredOn),
    firmware: pickFiles(entry.files.firmware, occurredOn),
  };
}
