/**
 * The sprint calendar: half months, 1st–15th and 16th–last day, as civil dates (YYYY-MM-DD) in the
 * app's time zone. Pure functions, so the rules are tested without a database.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const MON = MONTHS.map((m) => m.slice(0, 3));
const pad = (n: number) => String(n).padStart(2, '0');

export interface Half {
  year: number;
  month: number; // 1..12
  half: 1 | 2;
  starts_on: string;
  ends_on: string;
}

const utc = (date: string) => new Date(date + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** b − a in whole days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The half month a date falls in. */
export function halfOf(date: string): Half {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const half = day <= 15 ? 1 : 2;
  return {
    year, month, half,
    starts_on: `${year}-${pad(month)}-${half === 1 ? '01' : '16'}`,
    ends_on: `${year}-${pad(month)}-${half === 1 ? '15' : pad(lastDayOfMonth(year, month))}`,
  };
}

/** SPR-202610-01: the year, the month, and which half. */
export function refFor(h: Pick<Half, 'year' | 'month' | 'half'>): string {
  return `SPR-${h.year}${pad(h.month)}-0${h.half}`;
}

/** "Sprint · October 2026 · 01". */
export function defaultName(h: Pick<Half, 'year' | 'month' | 'half'>): string {
  return `Sprint · ${MONTHS[h.month - 1]} ${h.year} · 0${h.half}`;
}

/** "the first half of October 2026", for messages. */
export function halfLabel(h: Pick<Half, 'year' | 'month' | 'half'>): string {
  return `the ${h.half === 1 ? 'first' : 'second'} half of ${MONTHS[h.month - 1]} ${h.year}`;
}

/** "1–15 Oct 2026", or "28 Sep – 2 Oct 2026" across months. */
export function rangeLabel(starts: string, ends: string): string {
  const a = utc(starts), b = utc(ends);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${a.getUTCDate()} ${MON[a.getUTCMonth()]} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

/**
 * The sprint that follows one ending on `endsOn`: it starts the next day and runs to the end of
 * that day's half month. Normally that is a whole half; after a sprint that was stretched it is
 * the rest of the half, so sprints never overlap.
 */
export function sprintAfter(endsOn: string): { ref: string; name: string; starts_on: string; ends_on: string } {
  const starts = addDays(endsOn, 1);
  const h = halfOf(starts);
  return { ref: refFor(h), name: defaultName(h), starts_on: starts, ends_on: h.ends_on };
}

const REF_INPUT = /^spr-?(\d{4})(\d{2})-?0?([12])$/i;

/** "SPR-202610-01", "spr-202610-1", "SPR20261001" -> "SPR-202610-01". Anything else -> null. */
export function parseSprintRef(input: string): string | null {
  const m = REF_INPUT.exec(input.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `SPR-${m[1]}${m[2]}-0${m[3]}`;
}

export interface Timing {
  /** Days the sprint covers, both ends included. */
  days: number;
  /** Which day of the sprint today is (1-based), while it runs; null before it starts or once it is closed. */
  day: number | null;
  /** Days until the end, while the current sprint has not passed its end; otherwise null. */
  days_left: number | null;
  /** Days the current sprint has run past its end without being closed. */
  overdue_days: number;
  /** Days until it starts: a planned sprint, or a current one that began early because the one before closed early. */
  starts_in: number;
}

export function timing(s: { starts_on: string; ends_on: string; status: string }, today: string): Timing {
  const days = daysBetween(s.starts_on, s.ends_on) + 1;
  const startsIn = Math.max(0, daysBetween(today, s.starts_on));
  if (s.status === 'closed') return { days, day: null, days_left: null, overdue_days: 0, starts_in: 0 };
  if (s.status === 'planned') return { days, day: null, days_left: null, overdue_days: 0, starts_in: startsIn };
  const over = Math.max(0, daysBetween(s.ends_on, today));
  return {
    days,
    day: startsIn > 0 ? null : Math.min(days, daysBetween(s.starts_on, today) + 1),
    days_left: over > 0 ? null : daysBetween(today, s.ends_on),
    overdue_days: over,
    starts_in: startsIn,
  };
}
