/** 12-hour clock as the app sends it: "10:45 PM", "7:05 AM", "07:05 AM". Case-insensitive; normalizeTime12h() uppercases. */
export const TIME_12H_REGEX = /^(0?[1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/i;

export function isValidTime12h(value: string): boolean {
  return TIME_12H_REGEX.test(value);
}

/** Normalises "7:05 pm" -> "07:05 PM" so stored values are uniform. */
export function normalizeTime12h(value: string): string {
  const m = /^(\d{1,2}):(\d{2}) ([AaPp][Mm])$/.exec(value.trim());
  if (!m) return value;
  return `${m[1]!.padStart(2, '0')}:${m[2]} ${m[3]!.toUpperCase()}`;
}

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** True only for real calendar dates (rejects 2026-02-30). */
export function isValidCalendarDate(value: string): boolean {
  if (!DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today's civil date (YYYY-MM-DD) in the given IANA zone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Formats an instant as "YYYY-MM-DD HH:mm:ss" in the given zone plus the zone's UTC offset, e.g. "+05:30". */
export function formatInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${offset}`;
}
