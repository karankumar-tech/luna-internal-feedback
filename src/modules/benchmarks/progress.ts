/**
 * Progress: one tester's numbers the way a fitness app shows them to the person who sweated for
 * them. Streaks, weekly goals, personal bests, badges, a nudge or two and a leaderboard, all worked
 * out from the benchmark sessions they imported. Nothing new is stored: every figure comes from the
 * sessions and the totals their recordings already hold (never the samples).
 *
 * Whose number counts: a session's figures are read from its best reference device (a chest strap
 * or a sports watch first, by `referenceRank`) when one logged it, else from Luna, else from the
 * phone. The page is about the person, not the device, and Luna's own workouts in Apple Health often
 * carry no distance or calories. Each figure says where it came from.
 *
 * Effort minutes: minutes at 120–139 bpm count once and minutes at 140 bpm and above count twice
 * (Garmin's intensity minutes, against the 150 a week the WHO asks for). A workout without a heart
 * rate trace counts once, minute for minute.
 *
 * Days and weeks are the wearer's own (each session carries its UTC offset); a night belongs to the
 * morning it is woken from; weeks start on Monday.
 */
import type { HrQuality, Kind, MetricValue } from './analyze.js';
import { isOnFoot, referenceRank, tagLabel, TEST_TAG } from './metrics.js';

export interface ProgressDevice {
  tag: string;
  label: string | null;
  logged: boolean;
  metrics: Record<string, MetricValue>;
  hr: HrQuality | null;
}

/** A session with what Progress needs of its recordings. */
export interface ProgressSession {
  id: string;
  ref: string;
  kind: Kind;
  activity: string | null;
  title: string | null;
  tester: string;
  start: number;
  end: number;
  offset_min: number;
  /** When it was imported, seconds since the epoch. */
  uploaded_at: number;
  devices: ProgressDevice[];
}

export interface Goals { effort_min: number; workouts: number; km_on_foot: number; sleep_s: number }
/** The same for everyone until goals can be set per tester. */
export const GOALS: Goals = { effort_min: 150, workouts: 3, km_on_foot: 10, sleep_s: 7 * 3600 };

/** A workout shorter than this does not make an active day. */
export const MIN_WORKOUT_S = 10 * 60;
/** Uploaded within this of the session's end: "fresh". */
const FRESH_S = 3 * 86_400;
const DAY = 86_400;
const DEFAULT_OFFSET_MIN = 330;

// ---------------------------------------------------------------------------------------------
// The wearer's calendar
// ---------------------------------------------------------------------------------------------

/** Days since 1970-01-01 in the wearer's own time. */
export const localDay = (t: number, offsetMin: number): number => Math.floor((t + offsetMin * 60) / DAY);
/** "2026-10-09" for a day number. */
export const dayKey = (day: number): string => new Date(day * DAY * 1000).toISOString().slice(0, 10);
/** The Monday on or before a day. Day 4 (1970-01-05) was a Monday. */
export const weekStart = (day: number): number => day - ((((day - 4) % 7) + 7) % 7);
/** Minutes after the wearer's midnight. */
const clockMin = (t: number, offsetMin: number): number => ((((t + offsetMin * 60) % DAY) + DAY) % DAY) / 60;
const monthKey = (day: number): string => dayKey(day).slice(0, 7);

export const testerKey = (tester: string): string => tester.trim().toLowerCase();

// ---------------------------------------------------------------------------------------------
// One session, as facts about the person
// ---------------------------------------------------------------------------------------------

export interface Facts {
  id: string;
  ref: string;
  kind: Kind;
  activity: string | null;
  title: string | null;
  /** The wearer's day: a workout's start, a night's end. */
  day: number;
  start: number;
  end: number;
  offset_min: number;
  uploaded_at: number;
  duration_s: number;
  /** Minutes after the wearer's midnight the session started. A night that began before midnight is negative, counted from the morning's midnight. */
  start_min: number;
  effort_min: number;
  /** The effort came from a heart rate trace, not from the clock. */
  hr_based: boolean;
  on_foot: boolean;
  distance_km: number | null;
  kcal: number | null;
  steps: number | null;
  pace_s: number | null;
  max_pace_s: number | null;
  vo2max: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  sleep_s: number | null;
  in_bed_s: number | null;
  deep_s: number | null;
  rem_s: number | null;
  core_s: number | null;
  efficiency: number | null;
  /** The device the figures come from. */
  source: string;
  /** Luna and a reference device both logged it: the session the benchmarks exist for. */
  two_devices: boolean;
  /** Uploaded within three days of ending. */
  fresh: boolean;
}

/** References before Luna, Luna before the phone; a device that logged the session before one that only has readings from it. */
const kindRank = (tag: string): number => (tag === 'phone' ? 2 : tag === TEST_TAG ? 1 : 0);
export function deviceOrder<T extends { tag: string; logged: boolean }>(devices: T[]): T[] {
  return [...devices].sort((a, b) => Number(b.logged) - Number(a.logged) || kindRank(a.tag) - kindRank(b.tag) || referenceRank(a.tag) - referenceRank(b.tag));
}

/** Effort minutes from a heart rate trace's time in ranges, for a workout this long. */
export function effortMinutes(hr: HrQuality | null, durationS: number): { minutes: number; hr_based: boolean } {
  if (!hr || !hr.samples || !hr.zones.length) return { minutes: Math.round(durationS / 60), hr_based: false };
  const covered = (hr.coverage_pct / 100) * (durationS / 60);
  const share = (i: number) => (hr.zones[i] ?? 0) / 100;
  const moderate = covered * share(2);
  const vigorous = covered * (share(3) + share(4) + share(5));
  return { minutes: Math.round(moderate + 2 * vigorous), hr_based: true };
}

export function sessionFacts(s: ProgressSession): Facts {
  const order = deviceOrder(s.devices);
  const pick = (key: string): number | null => {
    for (const d of order) { const m = d.metrics[key]; if (m && Number.isFinite(m.value)) return m.value; }
    return null;
  };
  const hr = order.find((d) => d.hr && d.hr.samples > 0)?.hr ?? null;
  const duration = Math.max(0, s.end - s.start);
  const effort = s.kind === 'workout' ? effortMinutes(hr, duration) : { minutes: 0, hr_based: false };
  const day = localDay(s.kind === 'sleep' ? s.end : s.start, s.offset_min);
  const midnight = day * DAY - s.offset_min * 60;
  const lead = order[0];
  const lunaLogged = s.devices.some((d) => d.logged && d.tag === TEST_TAG);
  const refLogged = s.devices.some((d) => d.logged && d.tag !== TEST_TAG && d.tag !== 'phone');
  const inBed = pick('time_in_bed'), asleep = pick('total_sleep');
  return {
    id: s.id, ref: s.ref, kind: s.kind, activity: s.activity, title: s.title,
    day, start: s.start, end: s.end, offset_min: s.offset_min, uploaded_at: s.uploaded_at,
    duration_s: Math.round(duration),
    start_min: s.kind === 'sleep' ? Math.round((s.start - midnight) / 60) : Math.round(clockMin(s.start, s.offset_min)),
    effort_min: effort.minutes, hr_based: effort.hr_based,
    on_foot: s.kind === 'workout' && isOnFoot(s.activity),
    distance_km: pick('distance'), kcal: pick('active_energy'), steps: pick('steps'),
    pace_s: pick('pace'), max_pace_s: pick('max_pace'), vo2max: pick('vo2_max'),
    avg_hr: hr ? hr.mean : pick('heart_rate'),
    max_hr: order.find((d) => d.metrics.heart_rate?.max !== undefined)?.metrics.heart_rate?.max ?? null,
    sleep_s: asleep, in_bed_s: inBed, deep_s: pick('deep_sleep'), rem_s: pick('rem_sleep'), core_s: pick('core_sleep'),
    efficiency: pick('sleep_efficiency'),
    source: lead ? (lead.label || tagLabel(lead.tag)) : 'nothing',
    two_devices: lunaLogged && refLogged,
    fresh: s.uploaded_at - s.end <= FRESH_S,
  };
}

const activeWorkout = (f: Facts): boolean => f.kind === 'workout' && f.duration_s >= MIN_WORKOUT_S;

// ---------------------------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------------------------

/**
 * Days in a row with a workout, counted back from today; a day that has not had one yet does not
 * break the run, yesterday's does. `best` is the longest run ever.
 */
export function dayStreak(activeDays: Set<number>, today: number): { current: number; best: number; alive_today: boolean } {
  let current = 0;
  let d = activeDays.has(today) ? today : today - 1;
  while (activeDays.has(d)) { current++; d--; }
  let best = 0;
  for (const day of activeDays) {
    if (activeDays.has(day - 1)) continue;
    let n = 0;
    while (activeDays.has(day + n)) n++;
    best = Math.max(best, n);
  }
  return { current, best: Math.max(best, current), alive_today: activeDays.has(today) };
}

/** Weeks in a row on target, counted back from this week; this week only counts once it is hit. */
export function weekStreak(onTarget: Set<number>, thisWeek: number): { current: number; best: number } {
  let current = 0;
  let w = onTarget.has(thisWeek) ? thisWeek : thisWeek - 7;
  while (onTarget.has(w)) { current++; w -= 7; }
  let best = 0;
  for (const week of onTarget) {
    if (onTarget.has(week - 7)) continue;
    let n = 0;
    while (onTarget.has(week + 7 * n)) n++;
    best = Math.max(best, n);
  }
  return { current, best: Math.max(best, current) };
}

// ---------------------------------------------------------------------------------------------
// A week, a day, a night
// ---------------------------------------------------------------------------------------------

export interface WeekTotals {
  /** The Monday, "2026-10-05". */
  start: string;
  effort_min: number;
  workouts: number;
  minutes: number;
  km_on_foot: number;
  kcal: number;
  nights: number;
  sleep_avg_s: number | null;
  on_target: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function weekTotals(facts: Facts[], week: number, goals: Goals): WeekTotals {
  const inWeek = facts.filter((f) => weekStart(f.day) === week);
  const workouts = inWeek.filter(activeWorkout);
  const nights = inWeek.filter((f) => f.kind === 'sleep' && f.sleep_s !== null);
  const effort = workouts.reduce((n, f) => n + f.effort_min, 0);
  return {
    start: dayKey(week),
    effort_min: effort,
    workouts: workouts.length,
    minutes: Math.round(workouts.reduce((n, f) => n + f.duration_s, 0) / 60),
    km_on_foot: r1(workouts.reduce((n, f) => n + (f.on_foot && f.distance_km ? f.distance_km : 0), 0)),
    kcal: Math.round(workouts.reduce((n, f) => n + (f.kcal ?? 0), 0)),
    nights: nights.length,
    sleep_avg_s: nights.length ? Math.round(nights.reduce((n, f) => n + (f.sleep_s ?? 0), 0) / nights.length) : null,
    on_target: effort >= goals.effort_min,
  };
}

export interface DayCell { day: string; effort_min: number; workouts: number; minutes: number }

export interface Night {
  day: string;
  ref: string;
  sleep_s: number;
  in_bed_s: number | null;
  deep_s: number | null;
  rem_s: number | null;
  core_s: number | null;
  awake_s: number | null;
  efficiency: number | null;
  /** Minutes from the morning's midnight: −30 is half past eleven the evening before. */
  bedtime_min: number;
  wake_min: number;
  source: string;
}

function night(f: Facts): Night | null {
  if (f.kind !== 'sleep' || f.sleep_s === null) return null;
  return {
    day: dayKey(f.day), ref: f.ref, sleep_s: f.sleep_s, in_bed_s: f.in_bed_s,
    deep_s: f.deep_s, rem_s: f.rem_s, core_s: f.core_s,
    awake_s: f.in_bed_s !== null ? Math.max(0, f.in_bed_s - f.sleep_s) : null,
    efficiency: f.efficiency, bedtime_min: f.start_min, wake_min: f.start_min + Math.round(f.duration_s / 60), source: f.source,
  };
}

// ---------------------------------------------------------------------------------------------
// Personal bests
// ---------------------------------------------------------------------------------------------

export interface Best { key: string; label: string; value: number; unit: string; ref: string; day: string; new: boolean }

const BESTS: { key: string; label: string; unit: string; of: (f: Facts) => number | null; better: 'max' | 'min' }[] = [
  { key: 'longest_on_foot', label: 'Longest on foot', unit: 'km', of: (f) => (f.on_foot ? f.distance_km : null), better: 'max' },
  { key: 'fastest_km', label: 'Fastest kilometre', unit: 's/km', of: (f) => (f.on_foot ? f.max_pace_s ?? f.pace_s : null), better: 'min' },
  { key: 'biggest_burn', label: 'Biggest burn', unit: 'kcal', of: (f) => (f.kind === 'workout' ? f.kcal : null), better: 'max' },
  { key: 'longest_workout', label: 'Longest workout', unit: 's', of: (f) => (f.kind === 'workout' ? f.duration_s : null), better: 'max' },
  { key: 'most_effort', label: 'Hardest session', unit: 'effort min', of: (f) => (f.kind === 'workout' && f.hr_based ? f.effort_min : null), better: 'max' },
  { key: 'highest_hr', label: 'Highest heart rate', unit: 'bpm', of: (f) => (f.kind === 'workout' ? f.max_hr : null), better: 'max' },
  { key: 'vo2max', label: 'VO2max', unit: 'ml/kg/min', of: (f) => f.vo2max, better: 'max' },
  { key: 'best_night', label: 'Longest night', unit: 's', of: (f) => f.sleep_s, better: 'max' },
  { key: 'deepest_night', label: 'Most deep sleep', unit: 's', of: (f) => f.deep_s, better: 'max' },
];

function personalBests(facts: Facts[], thisWeek: number): Best[] {
  const out: Best[] = [];
  for (const b of BESTS) {
    let top: { f: Facts; v: number } | null = null;
    for (const f of facts) {
      const v = b.of(f);
      if (v === null || !Number.isFinite(v) || v <= 0) continue;
      // An earlier session keeps the record on a tie: the first to do it did it.
      if (!top || (b.better === 'max' ? v > top.v : v < top.v)) top = { f, v };
    }
    if (top) out.push({ key: b.key, label: b.label, value: top.v, unit: b.unit, ref: top.f.ref, day: dayKey(top.f.day), new: weekStart(top.f.day) === thisWeek });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------------

export interface Badge {
  key: string;
  name: string;
  how: string;
  /** The day it was earned, or null while it is still ahead. */
  earned: string | null;
  /** 0 to 1 on the way there; 1 once earned. */
  progress: number;
  /** What is left, in words, while it is still ahead. */
  left: string | null;
}

interface BadgeRule {
  key: string;
  name: string;
  how: string;
  /** Returns how far along (0 to 1) and the day the badge was earned, or null, from the sessions so far. */
  eval: (ctx: BadgeContext) => { progress: number; earned: number | null; left?: string };
}

interface BadgeContext {
  /** Chronological. */
  facts: Facts[];
  activeDays: Set<number>;
  onTargetWeeks: Set<number>;
  today: number;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** The day a running total crosses a line, scanning sessions in order. */
function crossing(facts: Facts[], add: (f: Facts) => number, target: number): { progress: number; earned: number | null; total: number } {
  let total = 0;
  for (const f of facts) {
    total += add(f);
    if (total >= target) return { progress: 1, earned: f.day, total };
  }
  return { progress: Math.min(1, total / target), earned: null, total };
}

/** The first session that does it. */
function firstThat(facts: Facts[], test: (f: Facts) => boolean): { progress: number; earned: number | null } {
  const f = facts.find(test);
  return f ? { progress: 1, earned: f.day } : { progress: 0, earned: null };
}

/** The day a run of consecutive days (or weeks, with `step` 7) first reaches `target`. */
function runReaches(set: Set<number>, step: number, target: number): { progress: number; earned: number | null; longest: number } {
  let longest = 0;
  let earned: number | null = null;
  for (const start of [...set].sort((a, b) => a - b)) {
    if (set.has(start - step)) continue;
    let n = 0;
    while (set.has(start + step * n)) n++;
    longest = Math.max(longest, n);
    if (n >= target && earned === null) earned = start + step * (target - 1);
  }
  return { progress: Math.min(1, longest / target), earned, longest };
}

const BADGE_RULES: BadgeRule[] = [
  { key: 'first', name: 'First steps', how: 'Import a first session.', eval: ({ facts }) => firstThat(facts, () => true) },
  { key: 'ten_k', name: '10K', how: 'Cover 10 km on foot in one go.', eval: ({ facts }) => {
    const r = firstThat(facts, (f) => f.on_foot && (f.distance_km ?? 0) >= 10);
    const far = Math.max(0, ...facts.map((f) => (f.on_foot ? f.distance_km ?? 0 : 0)));
    return r.earned !== null ? r : { progress: Math.min(1, far / 10), earned: null, left: `longest so far ${r1(far)} km` };
  } },
  { key: 'century', name: 'Century', how: '100 km on foot, all time.', eval: ({ facts }) => {
    const r = crossing(facts, (f) => (f.on_foot ? f.distance_km ?? 0 : 0), 100);
    return { ...r, left: `${r1(100 - r.total)} km to go` };
  } },
  { key: 'streak_7', name: 'On a roll', how: 'Work out seven days in a row.', eval: ({ activeDays }) => {
    const r = runReaches(activeDays, 1, 7);
    return { ...r, left: `best run ${plural(r.longest, 'day')}` };
  } },
  { key: 'weeks_4', name: 'Four in a row', how: 'Hit the effort goal four weeks running.', eval: ({ onTargetWeeks }) => {
    const r = runReaches(onTargetWeeks, 7, 4);
    return { progress: r.progress, earned: r.earned === null ? null : r.earned + 6, left: `best run ${plural(r.longest, 'week')}` };
  } },
  { key: 'early_bird', name: 'Early bird', how: 'Start a workout before 7 in the morning.', eval: ({ facts }) => firstThat(facts, (f) => activeWorkout(f) && f.start_min < 7 * 60) },
  { key: 'night_owl', name: 'Night owl', how: 'Start a workout after 9 at night.', eval: ({ facts }) => firstThat(facts, (f) => activeWorkout(f) && f.start_min >= 21 * 60) },
  { key: 'furnace', name: 'Furnace', how: 'Burn 500 kcal in one session.', eval: ({ facts }) => {
    const r = firstThat(facts, (f) => f.kind === 'workout' && (f.kcal ?? 0) >= 500);
    const most = Math.max(0, ...facts.map((f) => (f.kind === 'workout' ? f.kcal ?? 0 : 0)));
    return r.earned !== null ? r : { progress: Math.min(1, most / 500), earned: null, left: `biggest so far ${Math.round(most)} kcal` };
  } },
  { key: 'two_wrists', name: 'Two wrists', how: 'Five sessions with Luna and a reference device both logging: the ones the benchmarks are for.', eval: ({ facts }) => {
    const r = crossing(facts, (f) => (f.two_devices ? 1 : 0), 5);
    return { ...r, left: `${plural(5 - r.total, 'more session')}` };
  } },
  { key: 'data_hero', name: 'Data hero', how: 'Ten separate uploads.', eval: ({ facts }) => {
    const seen = new Set<number>();
    let earned: number | null = null;
    for (const f of facts) {
      seen.add(localDay(f.uploaded_at, f.offset_min));
      if (seen.size >= 10 && earned === null) earned = localDay(f.uploaded_at, f.offset_min);
    }
    return { progress: Math.min(1, seen.size / 10), earned, left: `${plural(10 - seen.size, 'more upload')}` };
  } },
  { key: 'fresh', name: 'Fresh', how: 'Five sessions uploaded within three days of doing them.', eval: ({ facts }) => {
    const r = crossing(facts, (f) => (f.fresh ? 1 : 0), 5);
    return { ...r, left: `${plural(5 - r.total, 'more')}` };
  } },
  { key: 'well_rested', name: 'Well rested', how: 'Seven nights of seven hours or more.', eval: ({ facts }) => {
    const r = crossing(facts, (f) => (f.kind === 'sleep' && (f.sleep_s ?? 0) >= 7 * 3600 ? 1 : 0), 7);
    return { ...r, left: `${plural(7 - r.total, 'more night')}` };
  } },
  { key: 'marathon_month', name: 'Marathon month', how: '42.2 km on foot in one calendar month.', eval: ({ facts }) => {
    const byMonth = new Map<string, number>();
    let earned: number | null = null, most = 0;
    for (const f of facts) {
      if (!f.on_foot || !f.distance_km) continue;
      const m = monthKey(f.day);
      const total = (byMonth.get(m) ?? 0) + f.distance_km;
      byMonth.set(m, total);
      most = Math.max(most, total);
      if (total >= 42.2 && earned === null) earned = f.day;
    }
    return { progress: Math.min(1, most / 42.2), earned, left: `best month ${r1(most)} km` };
  } },
];

function badges(ctx: BadgeContext): Badge[] {
  // Sessions are scanned in the order they happened, so "earned" is the day it was first true.
  const sorted = { ...ctx, facts: [...ctx.facts].sort((a, b) => a.start - b.start) };
  return BADGE_RULES.map((rule) => {
    const r = rule.eval(sorted);
    return {
      key: rule.key, name: rule.name, how: rule.how,
      earned: r.earned === null ? null : dayKey(r.earned),
      progress: r.earned === null ? Math.round(Math.max(0, Math.min(1, r.progress)) * 100) / 100 : 1,
      left: r.earned === null ? (r.left ?? null) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface Streaks {
  days: { current: number; best: number; alive_today: boolean };
  weeks: { current: number; best: number };
}

export interface ProgressReport {
  tester: string;
  /** "2026-10-09", the wearer's today. */
  today: string;
  offset_min: number;
  goals: Goals;
  week: WeekTotals & { days_left: number; pct: { effort: number; workouts: number; km: number; sleep: number } };
  last_week: WeekTotals;
  streaks: Streaks;
  weeks: WeekTotals[];
  days: DayCell[];
  nights: Night[];
  sleep: { avg_7_s: number | null; nights_7h_of_14: number; bedtime_spread_min: number | null };
  bests: Best[];
  badges: Badge[];
  nudges: string[];
  totals: {
    sessions: number; workouts: number; nights: number; km_on_foot: number; kcal: number; effort_min: number; minutes: number;
    two_devices: number; first_day: string | null; last_day: string | null; last_upload_at: string | null; days_since_upload: number | null;
  };
  /** The latest sessions, newest first, with the figures the page shows. */
  recent: { ref: string; kind: Kind; activity: string | null; title: string | null; day: string; duration_s: number; effort_min: number; distance_km: number | null; kcal: number | null; sleep_s: number | null; source: string; two_devices: boolean }[];
}

const pct = (have: number, goal: number) => (goal > 0 ? Math.min(100, Math.round((have / goal) * 100)) : 0);

export interface ProgressOptions { now: number; weeks?: number; goals?: Goals }

/** Everything the Progress page shows for one tester. `now` is seconds since the epoch. */
export function progressReport(tester: string, sessions: ProgressSession[], opts: ProgressOptions): ProgressReport {
  const goals = opts.goals ?? GOALS;
  const weeksBack = Math.max(4, Math.min(52, opts.weeks ?? 12));
  const facts = sessions.map(sessionFacts).sort((a, b) => a.start - b.start);
  const latest = sessions.reduce<ProgressSession | null>((best, s) => (!best || s.start > best.start ? s : best), null);
  const offset = latest?.offset_min ?? DEFAULT_OFFSET_MIN;
  const today = localDay(opts.now, offset);
  const thisWeek = weekStart(today);

  const activeDays = new Set(facts.filter(activeWorkout).map((f) => f.day));
  const weekSet = new Set(facts.map((f) => weekStart(f.day)));
  const onTarget = new Set([...weekSet].filter((w) => weekTotals(facts, w, goals).on_target));
  const streaks: Streaks = { days: dayStreak(activeDays, today), weeks: weekStreak(onTarget, thisWeek) };

  const week = weekTotals(facts, thisWeek, goals);
  const lastWeek = weekTotals(facts, thisWeek - 7, goals);
  const weeks: WeekTotals[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) weeks.push(weekTotals(facts, thisWeek - 7 * i, goals));

  const days: DayCell[] = [];
  for (let d = thisWeek - 7 * (weeksBack - 1); d < thisWeek + 7; d++) {
    const here = facts.filter((f) => activeWorkout(f) && f.day === d);
    days.push({ day: dayKey(d), effort_min: here.reduce((n, f) => n + f.effort_min, 0), workouts: here.length, minutes: Math.round(here.reduce((n, f) => n + f.duration_s, 0) / 60) });
  }

  const nights = facts.map(night).filter((n): n is Night => n !== null).slice(-14);
  const last7 = nights.slice(-7);
  const bedtimes = nights.map((n) => n.bedtime_min);
  const spread = bedtimes.length >= 3 ? (() => { const m = bedtimes.reduce((a, b) => a + b, 0) / bedtimes.length; return Math.round(Math.sqrt(bedtimes.reduce((a, b) => a + (b - m) ** 2, 0) / bedtimes.length)); })() : null;

  const workouts = facts.filter(activeWorkout);
  const lastUpload = sessions.reduce((t, s) => Math.max(t, s.uploaded_at), 0);
  const totals: ProgressReport['totals'] = {
    sessions: facts.length,
    workouts: workouts.length,
    nights: facts.filter((f) => f.kind === 'sleep').length,
    km_on_foot: r1(workouts.reduce((n, f) => n + (f.on_foot ? f.distance_km ?? 0 : 0), 0)),
    kcal: Math.round(workouts.reduce((n, f) => n + (f.kcal ?? 0), 0)),
    effort_min: workouts.reduce((n, f) => n + f.effort_min, 0),
    minutes: Math.round(workouts.reduce((n, f) => n + f.duration_s, 0) / 60),
    two_devices: facts.filter((f) => f.two_devices).length,
    first_day: facts[0] ? dayKey(facts[0].day) : null,
    last_day: facts.length ? dayKey(facts[facts.length - 1]!.day) : null,
    last_upload_at: lastUpload ? new Date(lastUpload * 1000).toISOString() : null,
    days_since_upload: lastUpload ? today - localDay(lastUpload, offset) : null,
  };

  const earned = badges({ facts, activeDays, onTargetWeeks: onTarget, today });
  const report: ProgressReport = {
    tester, today: dayKey(today), offset_min: offset, goals,
    week: {
      ...week,
      days_left: thisWeek + 6 - today,
      pct: { effort: pct(week.effort_min, goals.effort_min), workouts: pct(week.workouts, goals.workouts), km: pct(week.km_on_foot, goals.km_on_foot), sleep: week.sleep_avg_s === null ? 0 : pct(week.sleep_avg_s, goals.sleep_s) },
    },
    last_week: lastWeek,
    streaks, weeks, days, nights,
    sleep: {
      avg_7_s: last7.length ? Math.round(last7.reduce((n, x) => n + x.sleep_s, 0) / last7.length) : null,
      nights_7h_of_14: nights.filter((n) => n.sleep_s >= 7 * 3600).length,
      bedtime_spread_min: spread,
    },
    bests: personalBests(facts, thisWeek),
    badges: earned,
    nudges: [],
    totals,
    recent: [...facts].reverse().slice(0, 8).map((f) => ({
      ref: f.ref, kind: f.kind, activity: f.activity, title: f.title, day: dayKey(f.day), duration_s: f.duration_s, effort_min: f.effort_min,
      distance_km: f.distance_km, kcal: f.kcal, sleep_s: f.sleep_s, source: f.source, two_devices: f.two_devices,
    })),
  };
  report.nudges = nudges(report, facts);
  return report;
}

/** A sentence or three, the most useful first: what would move the numbers next. */
export function nudges(r: ProgressReport, facts: Facts[]): string[] {
  const out: string[] = [];
  if (!facts.length) return ['Nothing here yet. Import a health export and your numbers start the moment it lands.'];
  const since = r.totals.days_since_upload ?? 0;
  if (since >= 5) out.push(`Your last export was ${plural(since, 'day')} ago. Drop a fresh one so this week counts.`);
  const left = r.goals.effort_min - r.week.effort_min;
  if (left > 0) out.push(`${plural(left, 'effort minute')} to go this week${r.week.days_left > 0 ? ` with ${plural(r.week.days_left, 'day')} left` : ''}. A brisk half-hour walk is about 30.`);
  else out.push(`Week target done${r.streaks.weeks.current > 1 ? `: ${r.streaks.weeks.current} weeks in a row` : ''}. Anything more is a bonus.`);
  if (r.streaks.days.current > 0 && !r.streaks.days.alive_today) out.push(`Streak at ${plural(r.streaks.days.current, 'day')}. A workout today keeps it.`);
  const twoWrists = r.badges.find((b) => b.key === 'two_wrists');
  if (twoWrists && !twoWrists.earned) {
    const ref = facts.filter((f) => f.two_devices).map((f) => f.source).pop();
    out.push(`Wear Luna with ${ref ? `the ${ref}` : 'another device'} on the next one: ${twoWrists.left} for the Two wrists badge.`);
  }
  const workoutsLeft = r.goals.workouts - r.week.workouts;
  if (workoutsLeft > 0 && workoutsLeft < r.goals.workouts && left > 0) out.push(`${workoutsLeft === 1 ? 'One more workout' : `${workoutsLeft} more workouts`} makes ${r.goals.workouts} this week.`);
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------------------------
// Everyone
// ---------------------------------------------------------------------------------------------

export interface LeaderboardRow {
  tester: string;
  effort_week: number;
  workouts_week: number;
  km_week: number;
  sleep_avg_week_s: number | null;
  effort_30d: number;
  streak_days: number;
  streak_weeks: number;
  on_target: boolean;
  goal_effort_min: number;
  sessions: number;
  last_upload_at: string | null;
  days_since_upload: number | null;
}

/** One row per tester, the most effort this week first; a tie goes to the last 30 days. */
export function leaderboard(byTester: Map<string, ProgressSession[]>, opts: ProgressOptions): LeaderboardRow[] {
  const goals = opts.goals ?? GOALS;
  const rows: LeaderboardRow[] = [];
  for (const [, sessions] of byTester) {
    if (!sessions.length) continue;
    const r = progressReport(sessions[0]!.tester, sessions, { ...opts, weeks: 4 });
    const facts = sessions.map(sessionFacts);
    const today = localDay(opts.now, r.offset_min);
    const effort30 = facts.filter((f) => activeWorkout(f) && f.day > today - 30 && f.day <= today).reduce((n, f) => n + f.effort_min, 0);
    rows.push({
      tester: r.tester, effort_week: r.week.effort_min, workouts_week: r.week.workouts, km_week: r.week.km_on_foot, sleep_avg_week_s: r.week.sleep_avg_s,
      effort_30d: effort30, streak_days: r.streaks.days.current, streak_weeks: r.streaks.weeks.current, on_target: r.week.on_target, goal_effort_min: goals.effort_min,
      sessions: r.totals.sessions, last_upload_at: r.totals.last_upload_at, days_since_upload: r.totals.days_since_upload,
    });
  }
  return rows.sort((a, b) => b.effort_week - a.effort_week || b.effort_30d - a.effort_30d || a.tester.localeCompare(b.tester));
}

/** Sessions grouped by tester (case and spaces aside), each group named by its latest spelling. */
export function groupByTester(sessions: ProgressSession[]): Map<string, ProgressSession[]> {
  const out = new Map<string, ProgressSession[]>();
  for (const s of [...sessions].sort((a, b) => a.start - b.start)) {
    const key = testerKey(s.tester);
    const list = out.get(key) ?? [];
    list.push(s);
    out.set(key, list);
  }
  for (const list of out.values()) { const name = list[list.length - 1]!.tester; for (const s of list) s.tester = name; }
  return out;
}
