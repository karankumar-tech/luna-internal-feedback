import { describe, expect, it } from 'vitest';
import type { HrQuality, MetricValue } from '../../src/modules/benchmarks/analyze.js';
import {
  GOALS, MIN_WORKOUT_S, dayKey, dayStreak, deviceOrder, effortMinutes, groupByTester, leaderboard, localDay, progressReport, sessionFacts, weekStart, weekStreak,
  type ProgressDevice, type ProgressSession,
} from '../../src/modules/benchmarks/progress.js';

// 2026-10-09 is a Friday; the week started on Monday 2026-10-05. Everything is in IST (+5:30).
const IST = 330;
const H = 3600, D = 86_400;
/** Seconds since the epoch for a wall-clock moment in IST. */
const ist = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) / 1000 - IST * 60;
const NOW = ist(2026, 10, 9, 10);
const TODAY = localDay(NOW, IST);

const sum = (value: number, unit = ''): MetricValue => ({ label: '', unit, agg: 'sum', value, from: 'summary' });
const avg = (value: number, unit = '', max?: number): MetricValue => ({ label: '', unit, agg: 'avg', value, ...(max !== undefined ? { max } : {}), from: 'samples' });
const hr = (zones: number[], coverage = 100, mean = 140): HrQuality => ({ samples: 100, mean, interval_s: 1, coverage_pct: coverage, first_after_s: 0, holds: [], held_s: 0, held_pct: 0, gaps: [], gap_s: 0, zones });

let n = 0;
const device = (tag: string, over: Partial<ProgressDevice> = {}): ProgressDevice => ({ tag, label: null, logged: true, metrics: {}, hr: null, ...over });
function session(over: Partial<ProgressSession> & { start: number; end: number }): ProgressSession {
  n++;
  return { id: `id-${n}`, ref: `BM-${String(n).padStart(4, '0')}`, kind: 'workout', activity: 'running', title: null, tester: 'Navay', offset_min: IST, uploaded_at: over.end + H, devices: [], ...over };
}
/** A run with Polar and Luna both logging; Polar carries distance and calories, Luna only heart rate. */
const run = (start: number, minutes: number, km: number, kcal: number, over: Partial<ProgressSession> = {}) => session({
  start, end: start + minutes * 60, activity: 'running',
  devices: [
    device('polar', { metrics: { distance: sum(km, 'km'), active_energy: sum(kcal, 'kcal'), pace: avg(Math.round((minutes * 60) / km), 's/km'), heart_rate: avg(150, 'bpm', 172) }, hr: hr([0, 0, 20, 60, 20, 0]) }),
    device('luna', { metrics: { heart_rate: avg(147, 'bpm', 169) }, hr: hr([0, 0, 30, 50, 20, 0]) }),
  ],
  ...over,
});
/** A night by Luna alone, waking at 7 on the given morning. */
const night = (morning: number, sleepH: number, bedH = 7.5) => session({
  kind: 'sleep', activity: null, start: morning + 7 * H - bedH * H, end: morning + 7 * H,
  devices: [device('luna', { metrics: { time_in_bed: sum(bedH * H, 's'), total_sleep: sum(sleepH * H, 's'), deep_sleep: sum(1.2 * H, 's'), rem_sleep: sum(1.5 * H, 's'), core_sleep: sum((sleepH - 2.7) * H, 's'), sleep_efficiency: avg(Math.round((sleepH / bedH) * 100), '%') } })],
});

describe('the wearer’s calendar', () => {
  it('counts days and weeks in the wearer’s own time', () => {
    expect(dayKey(TODAY)).toBe('2026-10-09');
    expect(dayKey(weekStart(TODAY))).toBe('2026-10-05');
    // 00:30 IST on the 10th is still the 9th in UTC; the wearer’s day is the 10th.
    expect(dayKey(localDay(ist(2026, 10, 10, 0, 30), IST))).toBe('2026-10-10');
    // A Monday is its own week start; a Sunday belongs to the Monday before it.
    expect(dayKey(weekStart(localDay(ist(2026, 10, 5), IST)))).toBe('2026-10-05');
    expect(dayKey(weekStart(localDay(ist(2026, 10, 11), IST)))).toBe('2026-10-05');
  });
});

describe('one session as facts', () => {
  it('reads the figures from the reference device first, then Luna, then the phone', () => {
    const s = run(ist(2026, 10, 8, 18), 30, 5.2, 310);
    s.devices.push(device('phone', { logged: false, metrics: { steps: sum(4800), distance: sum(4.9, 'km') } }));
    s.devices.push(device('luna', { logged: false, metrics: {} }));
    expect(deviceOrder(s.devices).map((d) => d.tag)).toEqual(['polar', 'luna', 'luna', 'phone']);
    const f = sessionFacts(s);
    // The average comes from the reference's heart rate trace, the peak from its recorded maximum.
    expect(f).toMatchObject({ distance_km: 5.2, kcal: 310, steps: 4800, source: 'Polar', two_devices: true, on_foot: true, fresh: true, avg_hr: 140, max_hr: 172 });
    expect(f.day).toBe(localDay(ist(2026, 10, 8), IST));
    expect(f.start_min).toBe(18 * 60);
  });

  it('falls back to Luna’s own numbers, typed in or not, when no reference logged the workout', () => {
    const s = session({ start: ist(2026, 10, 8, 7), end: ist(2026, 10, 8, 7, 40), devices: [device('luna', { metrics: { distance: { ...sum(4, 'km'), from: 'manual' }, active_energy: sum(250, 'kcal') }, hr: hr([10, 30, 60, 0, 0, 0]) })] });
    const f = sessionFacts(s);
    expect(f).toMatchObject({ distance_km: 4, kcal: 250, source: 'Luna', two_devices: false, hr_based: true });
    // 40 min, 60% of it at 120–139: 24 moderate minutes, nothing vigorous.
    expect(f.effort_min).toBe(24);
  });

  it('turns time in heart rate ranges into effort minutes, twice for 140 and above', () => {
    expect(effortMinutes(hr([0, 0, 50, 50, 0, 0]), 60 * 60)).toEqual({ minutes: 90, hr_based: true });
    // Only three quarters of the hour had readings.
    expect(effortMinutes(hr([0, 0, 0, 100, 0, 0], 75), 60 * 60)).toEqual({ minutes: 90, hr_based: true });
    expect(effortMinutes(null, 45 * 60)).toEqual({ minutes: 45, hr_based: false });
    expect(effortMinutes(hr([], 0), 45 * 60)).toEqual({ minutes: 45, hr_based: false });
  });

  it('gives a night to the morning it ends on, with the bedtime counted from that midnight', () => {
    const morning = localDay(ist(2026, 10, 9), IST) * D - IST * 60;
    const f = sessionFacts(night(morning, 7, 7.5));
    expect(dayKey(f.day)).toBe('2026-10-09');
    expect(f.start_min).toBe(-30);
    expect(f).toMatchObject({ sleep_s: 7 * H, in_bed_s: 7.5 * H, deep_s: 1.2 * H, effort_min: 0 });
  });
});

describe('streaks', () => {
  it('counts days back from today, and lets today stay open', () => {
    const days = (...offsets: number[]) => new Set(offsets.map((o) => TODAY - o));
    expect(dayStreak(days(0, 1, 2), TODAY)).toEqual({ current: 3, best: 3, alive_today: true });
    expect(dayStreak(days(1, 2), TODAY)).toEqual({ current: 2, best: 2, alive_today: false });
    expect(dayStreak(days(2, 3), TODAY)).toEqual({ current: 0, best: 2, alive_today: false });
    expect(dayStreak(days(0, 5, 6, 7, 8), TODAY)).toEqual({ current: 1, best: 4, alive_today: true });
    expect(dayStreak(new Set(), TODAY)).toEqual({ current: 0, best: 0, alive_today: false });
  });

  it('counts weeks on target back from this week, which only counts once it is hit', () => {
    const w = weekStart(TODAY);
    expect(weekStreak(new Set([w, w - 7, w - 14]), w)).toEqual({ current: 3, best: 3 });
    expect(weekStreak(new Set([w - 7, w - 14]), w)).toEqual({ current: 2, best: 2 });
    expect(weekStreak(new Set([w - 14, w - 21, w - 35]), w)).toEqual({ current: 0, best: 2 });
  });
});

describe('the report', () => {
  const monday = localDay(ist(2026, 10, 5), IST) * D - IST * 60; // this week's Monday, midnight IST
  const history = () => {
    n = 0;
    return [
      // three weeks ago: one easy run
      run(monday - 21 * D + 18 * H, 30, 4, 240),
      // two weeks ago: on target with two hard runs
      run(monday - 14 * D + 18 * H, 60, 10.5, 650), run(monday - 12 * D + 18 * H, 45, 7, 420),
      // last week: on target, three sessions, one of them a short one that does not count
      run(monday - 7 * D + 6 * H, 50, 8, 500), run(monday - 5 * D + 18 * H, 50, 8, 480), session({ start: monday - 4 * D + 20 * H, end: monday - 4 * D + 20 * H + 5 * 60, devices: [device('luna', { metrics: {} })] }),
      // this week so far: Tuesday and Thursday (yesterday); nothing today yet
      run(monday + 1 * D + 18 * H, 40, 6, 380), run(monday + 3 * D + 18 * H, 40, 6.2, 390),
      // nights waking on Wed, Thu, Fri
      night(monday + 2 * D, 6.5), night(monday + 3 * D, 7.2), night(monday + 4 * D, 7.8),
    ];
  };

  it('adds up this week against the goals, with last week beside it', () => {
    const r = progressReport('Navay', history(), { now: NOW });
    expect(r.today).toBe('2026-10-09');
    // Two 40-minute runs, 20% moderate and 80% vigorous: 8 + 64 = 72 each.
    expect(r.week).toMatchObject({ start: '2026-10-05', effort_min: 144, workouts: 2, minutes: 80, km_on_foot: 12.2, kcal: 770, nights: 3, on_target: false, days_left: 2 });
    expect(r.week.pct).toEqual({ effort: 96, workouts: 67, km: 100, sleep: 100 });
    expect(r.week.sleep_avg_s).toBe(Math.round(((6.5 + 7.2 + 7.8) / 3) * H));
    expect(r.last_week).toMatchObject({ effort_min: 180, workouts: 2, on_target: true });
    expect(r.weeks).toHaveLength(12);
    expect(r.weeks[r.weeks.length - 1]!.start).toBe('2026-10-05');
    expect(r.days).toHaveLength(84);
    expect(r.days[r.days.length - 1]!.day).toBe('2026-10-11');
  });

  it('keeps the streaks: yesterday’s run holds the day streak open, and two weeks were on target', () => {
    const r = progressReport('Navay', history(), { now: NOW });
    expect(r.streaks.days).toEqual({ current: 1, best: 1, alive_today: false });
    expect(r.streaks.weeks).toEqual({ current: 2, best: 2 });
    expect(r.nudges[0]).toBe('6 effort minutes to go this week with 2 days left. A brisk half-hour walk is about 30.');
    expect(r.nudges).toContain('Streak at 1 day. A workout today keeps it.');
  });

  it('finds the personal bests and marks the ones set this week', () => {
    const r = progressReport('Navay', history(), { now: NOW });
    const best = Object.fromEntries(r.bests.map((b) => [b.key, b]));
    expect(best.longest_on_foot).toMatchObject({ value: 10.5, unit: 'km', ref: 'BM-0002', new: false });
    expect(best.biggest_burn).toMatchObject({ value: 650, unit: 'kcal' });
    expect(best.best_night).toMatchObject({ value: 7.8 * H, new: true, day: '2026-10-09' });
    expect(best.highest_hr).toMatchObject({ value: 172 });
  });

  it('earns badges on the day they were first true and says what is left for the rest', () => {
    const r = progressReport('Navay', history(), { now: NOW });
    const b = Object.fromEntries(r.badges.map((x) => [x.key, x]));
    expect(b.first).toMatchObject({ earned: '2026-09-14', progress: 1, left: null });
    expect(b.ten_k).toMatchObject({ earned: '2026-09-21' });
    // The fifth run with Polar and Luna both logging.
    expect(b.two_wrists).toMatchObject({ earned: '2026-09-30' });
    expect(b.early_bird).toMatchObject({ earned: '2026-09-28' });
    expect(b.night_owl.earned).toBeNull();
    // 4 + 10.5 + 7 + 8 + 8 + 6 + 6.2 = 49.7 km of 100
    expect(b.century).toMatchObject({ earned: null, progress: 0.5, left: '50.3 km to go' });
    // Every session was uploaded an hour after it ended: ten different days, the tenth being today's night.
    expect(b.data_hero).toMatchObject({ earned: '2026-10-09' });
    expect(b.well_rested).toMatchObject({ earned: null, progress: 0.29, left: '5 more nights' });
    // September had 37.5 km on foot, October 12.2 so far.
    expect(b.marathon_month).toMatchObject({ earned: null, progress: 0.89, left: 'best month 37.5 km' });
  });

  it('counts a workout only from ten minutes, and sums the totals', () => {
    const r = progressReport('Navay', history(), { now: NOW });
    expect(MIN_WORKOUT_S).toBe(600);
    expect(r.totals).toMatchObject({ sessions: 11, workouts: 7, nights: 3, km_on_foot: 49.7, two_devices: 7, first_day: '2026-09-14', last_day: '2026-10-09' });
    expect(r.recent[0]).toMatchObject({ kind: 'sleep', day: '2026-10-09' });
  });

  it('nudges someone whose export is going stale, and someone with nothing yet', () => {
    const stale = history().map((s) => ({ ...s, uploaded_at: s.end + H }));
    const r = progressReport('Navay', stale, { now: NOW + 9 * D });
    expect(r.totals.days_since_upload).toBe(9);
    expect(r.nudges[0]).toBe('Your last export was 9 days ago. Drop a fresh one so this week counts.');
    expect(progressReport('Tanmay', [], { now: NOW }).nudges).toEqual(['Nothing here yet. Import a health export and your numbers start the moment it lands.']);
  });

  it('uses the goals it is given', () => {
    const r = progressReport('Navay', history(), { now: NOW, goals: { ...GOALS, effort_min: 100 } });
    expect(r.week.on_target).toBe(true);
    expect(r.streaks.weeks.current).toBe(3);
    expect(r.nudges[0]).toBe('Week target done: 3 weeks in a row. Anything more is a bonus.');
  });
});

describe('everyone', () => {
  it('groups a tester however their name was typed and ranks by this week’s effort', () => {
    n = 0;
    const monday = localDay(ist(2026, 10, 5), IST) * D - IST * 60;
    const sessions = [
      run(monday + 1 * D + 18 * H, 40, 6, 380, { tester: 'navay' }),
      run(monday + 3 * D + 18 * H, 40, 6, 380, { tester: 'Navay ' }),
      run(monday + 2 * D + 18 * H, 30, 4, 250, { tester: 'Tanmay' }),
      run(monday - 20 * D + 18 * H, 90, 15, 900, { tester: 'Tanmay' }),
    ];
    const groups = groupByTester(sessions);
    expect([...groups.keys()].sort()).toEqual(['navay', 'tanmay']);
    expect(groups.get('navay')!.map((s) => s.tester)).toEqual(['Navay ', 'Navay ']);
    const board = leaderboard(groups, { now: NOW });
    expect(board.map((r) => [r.tester, r.effort_week, r.workouts_week])).toEqual([['Navay ', 144, 2], ['Tanmay', 54, 1]]);
    expect(board[1]).toMatchObject({ effort_30d: 54 + 162, streak_days: 0, on_target: false, sessions: 2 });
  });
});
