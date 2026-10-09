import { describe, expect, it } from 'vitest';
// The browser's export reader: plain JavaScript, no DOM, so it runs here as it runs on the page.
// @ts-expect-error no type declarations for the page script
import { extractSessions, openExport, parseDate, scanExport, vo2maxFor } from '../../src/pages/scripts/health-export.js';
import { analyzeSession, fastestPace, normalizeRecording, type IncomingRecording, type Rec } from '../../src/modules/benchmarks/analyze.js';
import { metricOf } from '../../src/modules/benchmarks/metrics.js';

const T0 = 1_790_000_000;
const window = { start: T0, end: T0 + 1200 };
const DISTANCE = 'HKQuantityTypeIdentifierDistanceWalkingRunning';
const workout = (activity = 'Running', km = 3) => ({
  activity: `HKWorkoutActivityType${activity}`, start: T0, end: T0 + 1200, duration: 20, duration_unit: 'min',
  stats: [{ type: DISTANCE, unit: 'km', sum: km }], metadata: {}, events: [],
});
const make = (id: string, tag: string, input: IncomingRecording): Rec => ({ ...normalizeRecording(input, 'workout', window), id, tag, label: input.source });

/** 6:00 a km, with a minute at 4:00 from 10 minutes in. */
const pace = (t: number) => (t >= 600 && t < 660 ? 240 : 360);

/** A GPS track heading east at pace(t) seconds per km, a point every `step` seconds; at 5 minutes the fix jumps 500 m away and back. */
function track(step = 2) {
  const lat = 28.67, kmPerDegree = 111.32 * Math.cos((lat * Math.PI) / 180);
  const t: number[] = [], la: number[] = [], lo: number[] = [];
  let lon = 77.45;
  for (let s = 0; s <= 1200; s += step) {
    t.push(s); la.push(lat); lo.push(s === 300 ? lon + 0.005 : lon);
    lon += step / pace(s) / kmPerDegree;
  }
  return { t0: T0, points: t.length, t, lat: la, lon: lo, ele: null, speed: null };
}

/** Distance written in pieces of `piece` seconds, at pace(t). */
function pieces(piece: number) {
  const s: number[] = [], e: number[] = [], v: number[] = [];
  for (let a = 0; a < 1200; a += piece) {
    let km = 0;
    for (let x = a; x < a + piece; x++) km += 1 / pace(x);
    s.push(a); e.push(a + piece); v.push(Math.round(km * 1e6) / 1e6);
  }
  return { [DISTANCE]: { unit: 'km', t0: T0, s, e, v } };
}

describe('max pace', () => {
  it('is the fastest pace held for half a minute, and needs the half minute', () => {
    const steady: [number, number][] = [[0, 0], [30, 0.1], [60, 0.2], [90, 0.25]];
    expect(fastestPace(steady)).toMatchObject({ pace: 300, at: 0, over_s: 30 });
    // Twenty seconds at 2:30 is not enough on its own.
    expect(fastestPace([[0, 0], [20, 0.1]])).toBeNull();
  });

  it('comes from the GPS track, where a fix that jumps adds no distance', () => {
    const strava = make('s', 'strava', { source: 'Strava', logged: true, samples: {}, workout: workout(), route: track() });
    const m = analyzeSession([strava], 'workout').metrics.get('s')!;
    expect(m.max_pace).toMatchObject({ unit: 's/km', from: 'derived', basis: 'route', over_s: 30 });
    expect(m.max_pace!.value).toBeGreaterThanOrEqual(239);
    expect(m.max_pace!.value).toBeLessThanOrEqual(241);
    expect(m.max_pace!.max_at).toBeGreaterThanOrEqual(T0 + 600);
    expect(m.max_pace!.max_at).toBeLessThanOrEqual(T0 + 630);
  });

  it('comes from distance readings when they are fine enough, and not from pieces of several minutes', () => {
    const watch = make('w', 'apple_watch', { source: 'Apple Watch', logged: true, samples: pieces(10), workout: workout() });
    expect(analyzeSession([watch], 'workout').metrics.get('w')!.max_pace).toMatchObject({ value: 240, from: 'derived', basis: 'distance', over_s: 30 });
    // Google Health and Luna write distance in pieces of minutes: the fastest stretch cannot be told from the average.
    const google = make('g', 'fitbit', { source: 'Google Health', logged: true, samples: pieces(240), workout: workout() });
    expect(analyzeSession([google], 'workout').metrics.get('g')!.max_pace).toBeUndefined();
  });

  it('takes the device’s own top speed first', () => {
    const w = { ...workout(), stats: [...workout().stats, { type: 'HKQuantityTypeIdentifierRunningSpeed', unit: 'km/hr', average: 10, minimum: 6, maximum: 18 }] };
    const watch = make('w', 'apple_watch', { source: 'Apple Watch', logged: true, samples: {}, workout: w, route: track() });
    expect(analyzeSession([watch], 'workout').metrics.get('w')!.max_pace).toMatchObject({ value: 200, from: 'summary', basis: 'speed' });
  });

  it('prefers what was typed in, and the comparison says where each side’s number came from', () => {
    const luna = make('l', 'luna', { source: 'Luna', logged: true, samples: pieces(600), workout: workout() });
    luna.details.manual = { max_pace_s: 250, by: 'qc@example.com', at: '2026-10-09T10:00:00Z' };
    const strava = make('s', 'strava', { source: 'Strava', logged: true, samples: {}, workout: workout(), route: track() });
    const a = analyzeSession([luna, strava], 'workout');
    expect(a.metrics.get('l')!.max_pace).toMatchObject({ value: 250, from: 'manual' });
    const row = a.summary.pairs[0]!.rows.find((r) => r.key === 'max_pace')!;
    expect(row).toMatchObject({ label: 'Max pace', unit: 's/km', test: 250 });
    expect(row.note).toBe('Strava: fastest 30 s of its GPS track. Luna: entered by hand.');
    // Rows run distance, average pace, then max pace.
    const keys = a.summary.pairs[0]!.rows.map((r) => r.key);
    expect(keys.indexOf('max_pace')).toBe(keys.indexOf('pace') + 1);
  });

  it('is only for a workout on foot', () => {
    const ride = make('r', 'garmin', { source: 'Connect', logged: true, samples: {}, workout: workout('Cycling'), route: track() });
    expect(analyzeSession([ride], 'workout').metrics.get('r')!.max_pace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// VO2max: what the Health app calls Cardio Fitness
// ---------------------------------------------------------------------------------------------

/** Like the 9 Oct export: Google Health's one VO2max reading is dated midnight, hours after the run. */
function exportWithVo2(): string {
  const rec = (type: string, source: string, unit: string, start: string, end: string, value: number) =>
    ` <Record type="${type}" sourceName="${source}" sourceVersion="50924075" unit="${unit}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>`;
  const run = (start: string, end: string) => [
    ` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="26" durationUnit="min" sourceName="Google Health" sourceVersion="50924075" creationDate="${end}" startDate="${start}" endDate="${end}">`,
    `  <WorkoutStatistics type="${DISTANCE}" startDate="${start}" endDate="${end}" sum="3.43106" unit="km"/>`,
    ' </Workout>',
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<HealthData locale="en_IN">',
    ' <ExportDate value="2026-10-09 12:28:50 +0530"/>',
    rec('HKQuantityTypeIdentifierHeartRate', 'Google Health', 'count/min', '2026-10-08 19:10:00 +0530', '2026-10-08 19:10:00 +0530', 150),
    rec('HKQuantityTypeIdentifierHeartRate', 'Google Health', 'count/min', '2026-10-07 17:15:00 +0530', '2026-10-07 17:15:00 +0530', 140),
    rec('HKQuantityTypeIdentifierVO2Max', 'Google Health', 'mL/min·kg', '2026-10-05 00:00:00 +0530', '2026-10-05 00:00:01 +0530', 48.1),
    rec('HKQuantityTypeIdentifierVO2Max', 'Google Health', 'mL/min·kg', '2026-10-09 00:00:00 +0530', '2026-10-09 00:00:01 +0530', 49.5719),
    ...run('2026-10-07 17:09:25 +0530', '2026-10-07 17:20:25 +0530'),
    ...run('2026-10-08 19:02:06 +0530', '2026-10-08 19:28:06 +0530'),
    '</HealthData>',
  ].join('\n');
}

describe('VO2max', () => {
  it('is VO2max in ml/kg/min, whatever the Health app calls it', () => {
    expect(metricOf('HKQuantityTypeIdentifierVO2Max', 'mL/min·kg')).toEqual({ key: 'vo2_max', label: 'VO2max', unit: 'ml/kg/min', agg: 'avg' });
  });

  it('is read from outside the workout: the next reading within a day, else the last one in the day before', async () => {
    const xml = exportWithVo2();
    const src = await openExport(new Blob([xml], { type: 'text/xml' }));
    const scan = await scanExport(src);
    expect(scan.vo2max['Google Health']).toHaveLength(2);
    const [earlier, later] = scan.workouts;
    const payloads = await extractSessions(src, [earlier, later].map((w, i) => ({ id: i, kind: 'workout', start: w.start, end: w.end, members: [w] })), scan);
    // 8 Oct 19:02: the midnight estimate five hours later is this run's.
    expect(payloads[1].recordings[0].vo2max).toEqual({ value: 49.57, unit: 'mL/min·kg', at: parseDate('2026-10-09 00:00:00 +0530') });
    // 7 Oct 17:09: the next one is more than a day after it, the one before more than a day before.
    expect(payloads[0].recordings[0].vo2max).toBeUndefined();
    // The reading is not a sample of the workout.
    expect(Object.keys(payloads[1].recordings[0].samples)).toEqual(['HKQuantityTypeIdentifierHeartRate']);
  });

  it('takes no reading nobody could have', () => {
    const scan = { vo2max: { X: [{ at: T0 + 100, value: 4.95, unit: 'mL/min·kg' }] } };
    expect(vo2maxFor(scan, 'X', T0, T0 + 1200)).toBeNull();
    expect(vo2maxFor(scan, 'Y', T0, T0 + 1200)).toBeNull();
  });

  it('shows as each device’s estimate with its date, side by side when both have one', () => {
    const at = T0 + 5 * 3600;
    const luna = make('l', 'luna', { source: 'Luna', logged: true, samples: {}, workout: workout(), vo2max: { value: 47.04, at } });
    const fitbit = make('f', 'fitbit', { source: 'Google Health', logged: true, samples: {}, workout: workout(), vo2max: { value: 49.57, unit: 'mL/min·kg', at } });
    const a = analyzeSession([luna, fitbit], 'workout');
    expect(a.metrics.get('f')!.vo2_max).toEqual({ label: 'VO2max', unit: 'ml/kg/min', agg: 'avg', value: 49.6, at, from: 'summary' });
    const row = a.summary.pairs[0]!.rows.find((r) => r.key === 'vo2_max')!;
    expect(row).toMatchObject({ reference: 49.6, test: 47, verdict: 'differs' });
    expect(row.note).toMatch(/Cardio Fitness/);
  });
});
