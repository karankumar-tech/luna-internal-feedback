/**
 * The numbers behind a benchmark session. Pure functions: what a device recorded goes in, its
 * totals, the quality of its heart rate trace and its agreement with another device come out.
 *
 * Times are seconds since the epoch. "Test" is the device being judged (Luna when it is present),
 * "reference" the one it is measured against.
 */
import { activityKey, convert, isOnFoot, metricOf, referenceRank, tagLabel, TEST_TAG, type Agg } from './metrics.js';

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export type Kind = 'workout' | 'sleep';

/** Samples over time. `d` is each sample's length for interval samples (steps from 18:03 to 18:13), else null. */
export interface Series {
  label: string;
  unit: string;
  agg: Agg;
  t0: number;
  t: number[];
  d: number[] | null;
  v: number[];
}

export type Stage = 'in_bed' | 'awake' | 'asleep' | 'core' | 'deep' | 'rem';
/** Sleep stages as runs: [seconds after t0, length in seconds, stage]. Built on 30-second epochs. */
export interface Stages {
  t0: number;
  epoch: number;
  runs: [number, number, Stage][];
}

export interface Route {
  t0: number;
  points: number;
  t: number[];
  lat: number[];
  lon: number[];
  ele: (number | null)[] | null;
  speed: (number | null)[] | null;
  distance_km: number;
}

export interface MetricValue {
  label: string;
  unit: string;
  agg: Agg;
  value: number;
  min?: number;
  max?: number;
  /** When the maximum was read; for a fastest pace, when that stretch started. */
  max_at?: number;
  /** When a single reading was taken, for one that stands for more than the session (a daily VO2max estimate). */
  at?: number;
  /** A fastest pace: how long the stretch it was held over is, and what it was worked out from. */
  over_s?: number;
  basis?: 'route' | 'distance' | 'speed';
  n?: number;
  /** A total pieced together from samples that only partly fall inside the session: an estimate. */
  approx?: boolean;
  /** summary: the device's own total. samples: added up from its samples. derived: worked out here. manual: typed in by a person. */
  from: 'summary' | 'samples' | 'derived' | 'manual';
}

export interface HrQuality {
  samples: number;
  /** Average over time: each reading counts for as long as it stood, so bursts of readings do not count for more. */
  mean: number;
  /** Typical seconds between readings. */
  interval_s: number;
  coverage_pct: number;
  /** Seconds from the start of the recording to its first reading. */
  first_after_s: number;
  /** Stretches of 40 s or more where the device reported exactly the same value. */
  holds: { t0: number; t1: number; value: number }[];
  held_s: number;
  held_pct: number;
  gaps: { t0: number; t1: number }[];
  gap_s: number;
  /** Share of time in each heart rate range, in the order of ZONE_LABELS. */
  zones: number[];
}

export interface Details {
  device?: Record<string, string> | null;
  profile?: { weight_kg?: number; height_cm?: number } | null;
  workout?: {
    raw_activity: string;
    duration_s: number | null;
    stats: { key: string; label: string; unit: string; agg: Agg; sum?: number; average?: number; minimum?: number; maximum?: number }[];
    metadata: Record<string, string>;
    events: { type: string; at: number; duration_s: number | null }[];
  } | null;
  hr?: HrQuality | null;
  sleep?: { has_stages: boolean } | null;
  /** The device's own VO2max estimate nearest the workout (Apple Health calls it Cardio Fitness), in ml/kg/min. */
  vo2max?: { value: number; at: number } | null;
  /** Typed in by a person, read off the device's own app, for what it did not write to Apple Health. */
  manual?: { distance_km?: number; active_kcal?: number; max_pace_s?: number; by: string | null; at: string } | null;
}

/** One device's recording, as stored. */
export interface Rec {
  id: string;
  source: string;
  tag: string;
  label: string;
  logged: boolean;
  activity: string | null;
  start: number;
  end: number;
  series: Record<string, Series>;
  stages: Stages | null;
  route: Route | null;
  details: Details;
}

export type Verdict = 'match' | 'close' | 'differs' | 'not_comparable' | 'only_test' | 'only_reference';

export interface Row {
  key: string;
  label: string;
  /** "clock" values are moments (epoch seconds); their diff is in seconds. */
  unit: string;
  reference: number | null;
  test: number | null;
  diff: number | null;
  pct: number | null;
  verdict: Verdict;
  note?: string;
}

export interface HrAgreement {
  overlap_s: number;
  /** 30-second blocks where both devices had a reading. */
  blocks: number;
  /** Mean of test minus reference: negative reads low. */
  bias: number;
  /** Mean absolute gap between the two, half-minute by half-minute: the "typical gap". */
  typical_gap: number;
  /** The gap on the middle half-minute: less moved by a bad stretch than the typical gap. */
  median_gap: number;
  rmse: number;
  r: number | null;
  within_5: number;
  within_10: number;
  max_gap: number;
  max_gap_at: number;
  loa_low: number;
  loa_high: number;
  /** The first three minutes, and everything after them. */
  warmup: { seconds: number; bias: number; typical_gap: number; verdict: Verdict } | null;
  steady: { bias: number; typical_gap: number; verdict: Verdict } | null;
  /** The start is far worse than the rest: the device was slow to find the pulse. */
  slow_start: boolean;
  /** Seconds the test device trails the reference, when shifting it clearly improves the match. */
  lag_s: number | null;
  verdict: Verdict;
}

export interface SleepAgreement {
  epochs: number;
  /** Asleep or awake, epoch by epoch. */
  sleep_wake_pct: number;
  /** Of the epochs the reference calls asleep, the share the test also calls asleep. */
  sensitivity: number | null;
  /** Of the epochs the reference calls awake, the share the test also calls awake. */
  specificity: number | null;
  /** Stage by stage (awake, light, deep, REM); null when either device has no stages. */
  stage_pct: number | null;
  kappa: number | null;
  labels: string[];
  /** confusion[reference][test], in epochs. */
  confusion: number[][] | null;
}

export interface Pair {
  test: string;
  reference: string;
  hr: HrAgreement | null;
  sleep: SleepAgreement | null;
  rows: Row[];
}

export interface Finding {
  level: 'good' | 'warn' | 'info';
  title: string;
  detail: string;
}

/** Bumped when the numbers are worked out differently, so stored sessions are redone when next read. */
export const ANALYSIS_VERSION = 4;

export interface Summary {
  version: number;
  kind: Kind;
  /** hr: the device has a heart rate trace in this session. */
  recordings: { id: string; source: string; tag: string; label: string; logged: boolean; hr: boolean }[];
  pairs: Pair[];
  /** Index into pairs of the comparison the page leads with. */
  primary: number | null;
  findings: Finding[];
  /** Why something a reader would expect to see compared is not: in plain sentences. */
  gaps: string[];
  /** When nothing at all is compared: the reason in a few words, for the list. Null when there is a comparison. */
  why: string | null;
  zone_labels: string[];
  headline: {
    test: string | null;
    reference: string | null;
    hr: { typical_gap: number; bias: number; r: number | null; verdict: Verdict } | null;
    sleep: { sleep_wake_pct: number; stage_pct: number | null } | null;
    rows: { key: string; label: string; unit: string; diff: number | null; pct: number | null; verdict: Verdict }[];
  };
}

const ZONE_EDGES = [100, 120, 140, 160, 180];
export const ZONE_LABELS = ['Below 100', '100–119', '120–139', '140–159', '160–179', '180 and above'];

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r5 = (n: number) => Math.round(n * 100_000) / 100_000;

// ---------------------------------------------------------------------------------------------
// From the upload to what is stored
// ---------------------------------------------------------------------------------------------

export interface IncomingSamples { unit: string; t0: number; s: number[]; e: number[] | null; v: number[] }
export interface IncomingRecording {
  source: string;
  source_version?: string | null;
  device?: Record<string, string> | null;
  logged: boolean;
  samples: Record<string, IncomingSamples>;
  workout?: {
    activity: string; start: number; end: number;
    duration?: number | null; duration_unit?: string | null;
    total_distance?: number | null; total_distance_unit?: string | null;
    total_energy?: number | null; total_energy_unit?: string | null;
    stats: { type: string; unit?: string; sum?: number; average?: number; minimum?: number; maximum?: number }[];
    metadata: Record<string, string>;
    events: { type?: string; at: number; duration?: number; durationUnit?: string }[];
  };
  sleep?: { start: number; end: number; segments: [number, number, string][] };
  route?: { t0: number; points: number; t: number[]; lat: number[]; lon: number[]; ele: (number | null)[] | null; speed: (number | null)[] | null } | null;
  profile?: { weight_kg?: number; height_cm?: number } | null;
  /** The source's VO2max reading nearest the workout, from outside it: devices estimate it once a day or after a workout. */
  vo2max?: { value: number; unit?: string; at: number } | null;
}

export type NormalizedRecording = Omit<Rec, 'id' | 'tag' | 'label'> & { source_version: string | null; fingerprint: string | null };

/** Columns of samples per Apple Health type -> one series per metric, in stored units, sorted by time. */
export function normalizeSeries(samples: Record<string, IncomingSamples>): Record<string, Series> {
  const parts = new Map<string, { info: ReturnType<typeof metricOf>; rows: [number, number, number][] }>();
  for (const [type, s] of Object.entries(samples)) {
    const info = metricOf(type, s.unit);
    let part = parts.get(info.key);
    if (!part) { part = { info, rows: [] }; parts.set(info.key, part); }
    const n = Math.min(s.s.length, s.v.length);
    for (let i = 0; i < n; i++) {
      const start = s.t0 + s.s[i]!;
      const end = s.e ? s.t0 + (s.e[i] ?? s.s[i]!) : start;
      const value = convert(info, s.unit, s.v[i]!);
      if (Number.isFinite(value) && Number.isFinite(start)) part.rows.push([start, Math.max(0, end - start), value]);
    }
  }
  const out: Record<string, Series> = {};
  for (const [key, { info, rows }] of parts) {
    if (!rows.length) continue;
    rows.sort((a, b) => a[0] - b[0]);
    const t0 = rows[0]![0];
    const hasLength = rows.some((r) => r[1] > 0);
    out[key] = {
      label: info.label, unit: info.unit, agg: info.agg, t0,
      t: rows.map((r) => r[0] - t0),
      d: hasLength ? rows.map((r) => r[1]) : null,
      // Distance to the centimetre: a watch writes it a few metres at a time, and a fastest pace is worked out from those.
      v: rows.map((r) => (key === 'distance' ? r5(r[2]) : r3(r[2]))),
    };
  }
  return out;
}

/**
 * One device's samples from two sessions that turn out to be one: every reading from both, once
 * each, in time order.
 */
export function mergeSeries(a: Record<string, Series>, b: Record<string, Series>): Record<string, Series> {
  const out: Record<string, Series> = { ...a };
  for (const [key, other] of Object.entries(b)) {
    const mine = out[key];
    if (!mine) { out[key] = other; continue; }
    const seen = new Set<string>();
    const rows: [number, number, number][] = [];
    for (const s of [mine, other]) {
      for (let i = 0; i < s.t.length; i++) {
        const row: [number, number, number] = [s.t0 + s.t[i]!, s.d ? s.d[i]! : 0, s.v[i]!];
        const id = row.join('|');
        if (seen.has(id)) continue;
        seen.add(id); rows.push(row);
      }
    }
    rows.sort((x, y) => x[0] - y[0]);
    const t0 = rows[0]![0];
    out[key] = { ...mine, t0, t: rows.map((r) => r[0] - t0), d: rows.some((r) => r[1] > 0) ? rows.map((r) => r[1]) : null, v: rows.map((r) => r[2]) };
  }
  return out;
}

const STAGE_OF: Record<string, Stage> = {
  InBed: 'in_bed', Awake: 'awake', Asleep: 'asleep', AsleepUnspecified: 'asleep',
  AsleepCore: 'core', AsleepDeep: 'deep', AsleepREM: 'rem',
};
const STAGE_CODE: Record<Stage, number> = { in_bed: 1, awake: 2, asleep: 3, core: 4, deep: 5, rem: 6 };
const CODE_STAGE: (Stage | null)[] = [null, 'in_bed', 'awake', 'asleep', 'core', 'deep', 'rem'];
/** A stage beats "asleep", which beats "awake", which beats "in bed", where records overlap. */
const strength = (code: number) => (code >= 4 ? 4 : code);
const EPOCH = 30;

/** Sleep records (which may overlap: "in bed" all night, stages inside it) -> one stage per 30 seconds. */
export function buildStages(segments: [number, number, string][], start: number, end: number): Stages {
  const n = Math.max(1, Math.ceil((end - start) / EPOCH));
  const epochs = new Uint8Array(n);
  for (const [s, e, value] of segments) {
    const stage = STAGE_OF[String(value).replace('HKCategoryValueSleepAnalysis', '')];
    if (!stage) continue;
    const code = STAGE_CODE[stage];
    const from = Math.max(0, Math.round((s - start) / EPOCH));
    const to = Math.min(n, Math.max(from + 1, Math.round((e - start) / EPOCH)));
    for (let i = from; i < to; i++) if (strength(code) >= strength(epochs[i]!)) epochs[i] = code;
  }
  return { t0: start, epoch: EPOCH, runs: toRuns(epochs) };
}

function toRuns(epochs: Uint8Array): [number, number, Stage][] {
  const runs: [number, number, Stage][] = [];
  let i = 0;
  while (i < epochs.length) {
    const code = epochs[i]!;
    let j = i + 1;
    while (j < epochs.length && epochs[j] === code) j++;
    const stage = CODE_STAGE[code];
    if (stage) runs.push([i * EPOCH, (j - i) * EPOCH, stage]);
    i = j;
  }
  return runs;
}

/** Stage codes per 30-second epoch over [from, to); 0 where the device recorded nothing. */
function epochsOf(stages: Stages, from: number, to: number): Uint8Array {
  const n = Math.max(0, Math.ceil((to - from) / EPOCH));
  const out = new Uint8Array(n);
  for (const [offset, length, stage] of stages.runs) {
    const a = Math.round((stages.t0 + offset - from) / EPOCH);
    const b = Math.round((stages.t0 + offset + length - from) / EPOCH);
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) out[i] = STAGE_CODE[stage];
  }
  return out;
}

const R_EARTH_KM = 6371.0088;
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toSeconds(value: number | null | undefined, unit: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const u = (unit ?? 'min').toLowerCase();
  return u === 's' || u === 'sec' ? value : u === 'hr' || u === 'h' ? value * 3600 : value * 60;
}

export const fingerprintOf = (kind: Kind, source: string, start: number, end: number) => `${kind}|${source}|${Math.round(start)}|${Math.round(end)}`;

/** One uploaded recording -> what is stored. Window: the session's, used for a source that logged nothing itself. */
export function normalizeRecording(input: IncomingRecording, kind: Kind, window: { start: number; end: number }): NormalizedRecording {
  const series = normalizeSeries(input.samples ?? {});
  const details: Details = { device: input.device ?? null, profile: input.profile ?? null };
  let start = window.start, end = window.end;
  let activity: string | null = null;
  let stages: Stages | null = null;
  let route: Route | null = null;
  let fingerprint: string | null = null;

  if (kind === 'workout' && input.workout) {
    const w = input.workout;
    start = w.start; end = w.end;
    activity = activityKey(w.activity);
    fingerprint = fingerprintOf(kind, input.source, start, end);
    const stats: NonNullable<Details['workout']>['stats'] = [];
    for (const s of w.stats ?? []) {
      const info = metricOf(s.type, s.unit ?? '');
      if (stats.some((x) => x.key === info.key)) continue;
      const c = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : r3(convert(info, s.unit ?? '', v)));
      stats.push({ key: info.key, label: info.label, unit: info.unit, agg: info.agg, sum: c(s.sum), average: c(s.average), minimum: c(s.minimum), maximum: c(s.maximum) });
    }
    // Older exports carry the totals on the workout itself rather than as statistics.
    if (w.total_distance !== null && w.total_distance !== undefined && !stats.some((x) => x.key === 'distance')) {
      const info = metricOf('HKQuantityTypeIdentifierDistanceWalkingRunning', w.total_distance_unit ?? 'km');
      stats.push({ key: 'distance', label: info.label, unit: info.unit, agg: 'sum', sum: r3(convert(info, w.total_distance_unit ?? 'km', w.total_distance)) });
    }
    if (w.total_energy !== null && w.total_energy !== undefined && !stats.some((x) => x.key === 'active_energy')) {
      const info = metricOf('HKQuantityTypeIdentifierActiveEnergyBurned', w.total_energy_unit ?? 'kcal');
      stats.push({ key: 'active_energy', label: info.label, unit: info.unit, agg: 'sum', sum: r3(convert(info, w.total_energy_unit ?? 'kcal', w.total_energy)) });
    }
    details.workout = {
      raw_activity: w.activity,
      duration_s: toSeconds(w.duration, w.duration_unit),
      stats,
      metadata: w.metadata ?? {},
      events: (w.events ?? []).map((e) => ({ type: String(e.type ?? '').replace('HKWorkoutEventType', ''), at: e.at, duration_s: toSeconds(e.duration, e.durationUnit) })),
    };
    if (input.vo2max && Number.isFinite(input.vo2max.value)) details.vo2max = { value: r1(input.vo2max.value), at: input.vo2max.at };
    if (input.route && input.route.t.length >= 2) {
      const r = input.route;
      let km = 0;
      for (let i = 1; i < r.lat.length; i++) km += haversineKm(r.lat[i - 1]!, r.lon[i - 1]!, r.lat[i]!, r.lon[i]!);
      route = { ...r, distance_km: r3(km) };
    }
  } else if (kind === 'sleep' && input.sleep) {
    start = input.sleep.start; end = input.sleep.end;
    fingerprint = fingerprintOf(kind, input.source, start, end);
    stages = buildStages(input.sleep.segments, start, end);
    details.sleep = { has_stages: stages.runs.some((r) => r[2] === 'core' || r[2] === 'deep' || r[2] === 'rem') };
  }

  return { source: input.source, source_version: input.source_version ?? null, logged: fingerprint !== null, fingerprint, activity, start, end, series, stages, route, details };
}

// ---------------------------------------------------------------------------------------------
// One recording: totals, averages, heart rate quality
// ---------------------------------------------------------------------------------------------

/** Mean of a reading per bucket over [from, to); null where the device had no reading. */
export function bucketMeans(s: Series, from: number, to: number, step: number): (number | null)[] {
  const n = Math.max(0, Math.ceil((to - from) / step));
  const sum = new Float64Array(n), count = new Uint32Array(n);
  for (let i = 0; i < s.t.length; i++) {
    const at = s.t0 + s.t[i]! + (s.d ? s.d[i]! / 2 : 0);
    const b = Math.floor((at - from) / step);
    if (b < 0 || b >= n) continue;
    sum[b]! += s.v[i]!; count[b]! += 1;
  }
  const out: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = count[i] ? sum[i]! / count[i]! : null;
  return out;
}

/**
 * A total over [from, to]. A sample that straddles an edge counts for the part inside, and marks the
 * total as an estimate. A sample longer than the session itself (an hourly step count against a
 * ten-minute walk, a whole day's calories) says nothing about the session and is left out.
 */
function sumIn(s: Series, from: number, to: number): { value: number; n: number; approx: boolean } {
  let value = 0, n = 0, approx = false;
  const span = to - from;
  for (let i = 0; i < s.t.length; i++) {
    const a = s.t0 + s.t[i]!;
    const length = s.d ? s.d[i]! : 0;
    if (length <= 0) { if (a >= from && a <= to) { value += s.v[i]!; n++; } continue; }
    const overlap = Math.min(to, a + length) - Math.max(from, a);
    if (overlap <= 0) continue;
    if (overlap < length) {
      if (length > span) continue;
      approx = true;
    }
    value += s.v[i]! * (overlap / length); n++;
  }
  return { value, n, approx };
}

function averageIn(s: Series, from: number, to: number): { value: number; min: number; max: number; maxAt: number; n: number } | null {
  let sum = 0, weight = 0, min = Infinity, max = -Infinity, maxAt = 0, n = 0;
  for (let i = 0; i < s.t.length; i++) {
    const a = s.t0 + s.t[i]!;
    const length = s.d ? s.d[i]! : 0;
    if (a + length < from || a > to) continue;
    // A reading that stands for longer than the session (a daily average) is not a reading of it.
    if (length > to - from) continue;
    const w = length > 0 ? length : 1;
    const v = s.v[i]!;
    sum += v * w; weight += w; n++;
    if (v < min) min = v;
    if (v > max) { max = v; maxAt = a; }
  }
  return n ? { value: sum / weight, min, max, maxAt, n } : null;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
};

/** A fastest pace has to be held at least this long: over a few seconds it is GPS noise. */
const PACE_WINDOW_S = 30;
/** Distance written in pieces longer than this cannot tell the fastest stretch from the average. */
const PACE_DETAIL_S = 120;
/** Faster than 2:00 a kilometre on foot, held for half a minute, is a GPS jump rather than a runner. */
const FASTEST_ON_FOOT_S_PER_KM = 120;
/** Between two GPS points, faster than this (43 km/h) is the fix jumping: that step adds no distance. */
const GPS_JUMP_KM_PER_S = 0.012;

type Track = [number, number][];

/** [moment, km so far] along a GPS track. */
function routeTrack(route: Route): Track {
  const out: Track = [];
  let km = 0;
  for (let i = 0; i < route.t.length; i++) {
    if (i) {
      const step = haversineKm(route.lat[i - 1]!, route.lon[i - 1]!, route.lat[i]!, route.lon[i]!);
      const dt = route.t[i]! - route.t[i - 1]!;
      if (dt > 0 && step / dt <= GPS_JUMP_KM_PER_S) km += step;
    }
    out.push([route.t0 + route.t[i]!, km]);
  }
  return out;
}

/**
 * The same from distance samples inside [from, to], each piece spread evenly over its own span.
 * Null when the device wrote its distance in pieces too long to show a fastest stretch.
 */
function distanceTrack(s: Series, from: number, to: number): Track | null {
  if (!s.d) return null;
  const pieces: [number, number, number][] = [];
  for (let i = 0; i < s.t.length; i++) {
    const a = s.t0 + s.t[i]!, b = a + s.d[i]!;
    if (s.d[i]! > 0 && b > from && a < to) pieces.push([a, b, s.v[i]!]);
  }
  if (pieces.length < 3 || median(pieces.map((p) => p[1] - p[0])) > PACE_DETAIL_S) return null;
  pieces.sort((x, y) => x[0] - y[0]);
  const out: Track = [];
  let km = 0, last = -Infinity;
  for (const [a0, b, v] of pieces) {
    // Pieces that overlap count once: only the part after the previous one ended.
    const a = Math.max(a0, last);
    if (b <= a) continue;
    out.push([a, km]);
    km += v * ((b - a) / (b - a0));
    out.push([b, km]);
    last = b;
  }
  return out;
}

/** The fastest pace (seconds per km) held over at least `window` seconds of a track, where it starts and how long it is. */
export function fastestPace(track: Track, window = PACE_WINDOW_S): { pace: number; at: number; over_s: number } | null {
  let best: { pace: number; at: number; over_s: number } | null = null;
  let j = 0;
  for (let i = 0; i < track.length; i++) {
    if (j < i) j = i;
    while (j < track.length && track[j]![0] - track[i]![0] < window) j++;
    if (j >= track.length) break;
    const dt = track[j]![0] - track[i]![0], km = track[j]![1] - track[i]![1];
    if (!(km > 0)) continue;
    const pace = dt / km;
    if (pace < FASTEST_ON_FOOT_S_PER_KM) continue;
    if (!best || pace < best.pace) best = { pace, at: track[i]![0], over_s: dt };
  }
  return best;
}

/**
 * A workout's fastest pace, from the finest detail the device wrote: its own top speed, its GPS
 * track, its distance pieces, or its speed readings, in that order.
 */
function fastestOf(rec: Rec, metrics: Record<string, MetricValue>, from: number, to: number): { pace: number; from: MetricValue['from']; basis: NonNullable<MetricValue['basis']>; at?: number; over_s?: number } | null {
  const top = (m: MetricValue | undefined) => (m && m.max !== undefined && 3600 / m.max >= FASTEST_ON_FOOT_S_PER_KM ? m : undefined);
  const speeds = [metrics.running_speed, metrics.walking_speed].map(top);
  const own = speeds.find((m) => m?.from === 'summary');
  if (own) return { pace: 3600 / own.max!, from: 'summary', basis: 'speed' };
  const tracks: [NonNullable<MetricValue['basis']>, Track | null][] = [
    ['route', rec.route && rec.route.t.length >= 2 ? routeTrack(rec.route) : null],
    ['distance', rec.series.distance ? distanceTrack(rec.series.distance, from, to) : null],
  ];
  for (const [basis, track] of tracks) {
    const f = track ? fastestPace(track) : null;
    if (f) return { pace: f.pace, from: 'derived', basis, at: f.at, over_s: f.over_s };
  }
  const read = speeds.find((m) => m && (m.n ?? 0) >= 3);
  if (read) return { pace: 3600 / read.max!, from: 'samples', basis: 'speed', at: read.max_at };
  return null;
}

/** How good the heart rate trace is on its own: sampling, dropouts, stuck values, time in ranges. */
export function heartRateQuality(s: Series, from: number, to: number): HrQuality | null {
  const t: number[] = [], v: number[] = [];
  for (let i = 0; i < s.t.length; i++) { const at = s.t0 + s.t[i]!; if (at >= from && at <= to) { t.push(at); v.push(s.v[i]!); } }
  if (t.length < 2) return null;
  const steps: number[] = [];
  for (let i = 1; i < t.length; i++) steps.push(t[i]! - t[i - 1]!);
  const interval = Math.max(1, median(steps));
  const reach = Math.max(10, interval * 3);
  const gapLimit = Math.max(15, interval * 5);

  // Each reading stands until the next one, up to a few sampling intervals. That span is its
  // weight in the average and in the time per range, and what counts as covered.
  let covered = 0, weighted = 0;
  const zones = new Array<number>(ZONE_LABELS.length).fill(0);
  const gaps: HrQuality['gaps'] = [];
  if (t[0]! - from > gapLimit) gaps.push({ t0: from, t1: t[0]! });
  for (let i = 0; i < t.length; i++) {
    const next = i + 1 < t.length ? t[i + 1]! : Math.min(to, t[i]! + interval);
    const stood = Math.max(0, Math.min(next - t[i]!, reach));
    covered += stood; weighted += v[i]! * stood;
    let z = 0; while (z < ZONE_EDGES.length && v[i]! >= ZONE_EDGES[z]!) z++;
    zones[z]! += stood;
    if (i + 1 < t.length && next - t[i]! > gapLimit) gaps.push({ t0: t[i]!, t1: next });
  }
  if (to - t[t.length - 1]! > gapLimit) gaps.push({ t0: t[t.length - 1]!, t1: to });
  const span = Math.max(1, to - from);
  const mean = covered > 0 ? weighted / covered : v.reduce((a, b) => a + b, 0) / v.length;

  // A value that does not move for 40 s is the device repeating itself, not a steady heart. Only
  // meaningful when it samples often enough to see a change.
  const holds: HrQuality['holds'] = [];
  if (interval <= 10) {
    let i = 0;
    while (i < t.length) {
      let j = i;
      while (j + 1 < t.length && v[j + 1] === v[i] && t[j + 1]! - t[j]! <= gapLimit) j++;
      if (j - i + 1 >= 5 && t[j]! - t[i]! >= 40) holds.push({ t0: t[i]!, t1: t[j]!, value: v[i]! });
      i = j + 1;
    }
  }
  const held = holds.reduce((sum, h) => sum + (h.t1 - h.t0), 0);

  return {
    samples: t.length,
    mean: r1(mean),
    interval_s: r1(interval),
    coverage_pct: r1(Math.min(100, (covered / span) * 100)),
    first_after_s: Math.round(t[0]! - from),
    holds, held_s: Math.round(held), held_pct: r1((held / span) * 100),
    gaps: gaps.slice(0, 50), gap_s: Math.round(gaps.reduce((sum, g) => sum + (g.t1 - g.t0), 0)),
    zones: zones.map((z) => (covered > 0 ? r1((z / covered) * 100) : 0)),
  };
}

/** Everything a night's stages say: time in bed, time asleep, how long to fall asleep, time awake, each stage. */
export function sleepMetrics(stages: Stages, start: number, end: number): Record<string, MetricValue> {
  const e = epochsOf(stages, start, end);
  const out: Record<string, MetricValue> = {};
  const put = (key: string, label: string, value: number, unit = 's') => { out[key] = { label, unit, agg: 'sum', value, from: 'derived' }; };
  let first = -1, last = -1, onset = -1, final = -1;
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < e.length; i++) {
    const code = e[i]!;
    counts[code]! += 1;
    if (code) { if (first === -1) first = i; last = i; }
    if (code >= 3) { if (onset === -1) onset = i; final = i; }
  }
  if (first === -1) return out;
  const inBed = (last - first + 1) * EPOCH;
  put('time_in_bed', 'Time in bed', inBed);
  if (onset === -1) return out;

  const asleep = (counts[3]! + counts[4]! + counts[5]! + counts[6]!) * EPOCH;
  put('total_sleep', 'Time asleep', asleep);
  // Without anything before the first sleep, the device did not record the wait for it.
  if (onset > first) put('sleep_latency', 'Time to fall asleep', (onset - first) * EPOCH);
  let waso = 0, awakenings = 0, run = 0;
  for (let i = onset; i <= final; i++) {
    if (e[i]! >= 3) { if (run >= 2) awakenings++; run = 0; } else { waso++; run++; }
  }
  put('waso', 'Awake after falling asleep', waso * EPOCH);
  out.awakenings = { label: 'Times awake', unit: '', agg: 'sum', value: awakenings, from: 'derived' };
  out.sleep_efficiency = { label: 'Sleep efficiency', unit: '%', agg: 'avg', value: r1((asleep / inBed) * 100), from: 'derived' };
  if (counts[5]) put('deep_sleep', 'Deep sleep', counts[5]! * EPOCH);
  if (counts[4]) put('core_sleep', 'Light (core) sleep', counts[4]! * EPOCH);
  if (counts[6]) put('rem_sleep', 'REM sleep', counts[6]! * EPOCH);
  if (counts[3]) put('unstaged_sleep', 'Asleep, no stage given', counts[3]! * EPOCH);
  return out;
}

/** A recording's totals and averages. `window` is the session's, used when the device logged nothing itself. */
export function recordingMetrics(rec: Rec, kind: Kind, window: { start: number; end: number }): { metrics: Record<string, MetricValue>; hr: HrQuality | null } {
  const from = rec.logged ? rec.start : window.start;
  const to = rec.logged ? rec.end : window.end;
  const metrics: Record<string, MetricValue> = {};

  if (kind === 'workout' && rec.logged) {
    const duration = rec.details.workout?.duration_s ?? rec.end - rec.start;
    metrics.duration = { label: 'Duration', unit: 's', agg: 'sum', value: Math.round(duration), from: 'summary' };
    for (const s of rec.details.workout?.stats ?? []) {
      if (s.agg === 'sum' && s.sum !== undefined) metrics[s.key] = { label: s.label, unit: s.unit, agg: 'sum', value: s.sum, from: 'summary' };
      else if (s.agg === 'avg' && s.average !== undefined) metrics[s.key] = { label: s.label, unit: s.unit, agg: 'avg', value: s.average, min: s.minimum, max: s.maximum, from: 'summary' };
    }
    // A total typed in by hand stands in for the one the device did not write; pace and speed follow from the distance below.
    const manual = rec.details.manual;
    if (manual?.distance_km) metrics.distance = { label: 'Distance', unit: 'km', agg: 'sum', value: manual.distance_km, from: 'manual' };
    if (manual?.active_kcal) metrics.active_energy = { label: 'Active calories', unit: 'kcal', agg: 'sum', value: manual.active_kcal, from: 'manual' };
  }
  if (kind === 'sleep' && rec.stages) Object.assign(metrics, sleepMetrics(rec.stages, rec.start, rec.end));

  let hr: HrQuality | null = null;
  for (const [key, s] of Object.entries(rec.series)) {
    if (s.agg === 'sum') {
      if (metrics[key]) continue;
      const total = sumIn(s, from, to);
      if (total.n) metrics[key] = { label: s.label, unit: s.unit, agg: 'sum', value: r3(total.value), n: total.n, from: 'samples', ...(total.approx ? { approx: true } : {}) };
      continue;
    }
    const a = averageIn(s, from, to);
    if (!a) continue;
    let value = a.value;
    if (key === 'heart_rate') {
      hr = heartRateQuality(s, from, to);
      if (hr) value = hr.mean;
      // The device's own summary stands in when it wrote too few samples to average.
      if (a.n < 10 && metrics[key]) continue;
    }
    metrics[key] = { label: s.label, unit: s.unit, agg: 'avg', value: r1(value), min: r1(a.min), max: r1(a.max), max_at: a.maxAt, n: a.n, from: 'samples' };
  }

  if (kind === 'workout' && rec.logged) {
    const duration = metrics.duration?.value ?? 0;
    const distance = metrics.distance?.value ?? 0;
    if (distance >= 0.05 && duration > 0) {
      metrics.speed = { label: 'Average speed', unit: 'km/h', agg: 'avg', value: r2(distance / (duration / 3600)), from: 'derived' };
      if (isOnFoot(rec.activity)) metrics.pace = { label: 'Average pace', unit: 's/km', agg: 'avg', value: Math.round(duration / distance), from: 'derived' };
    }
    if (metrics.steps && duration > 0 && isOnFoot(rec.activity)) {
      metrics.cadence = { label: 'Cadence', unit: 'steps/min', agg: 'avg', value: Math.round(metrics.steps.value / (duration / 60)), from: 'derived' };
    }
    if (isOnFoot(rec.activity)) {
      // No device writes its fastest pace to Apple Health, so a number read off its app comes first.
      const typed = rec.details.manual?.max_pace_s;
      const f = typed ? null : fastestOf(rec, metrics, from, to);
      if (typed) metrics.max_pace = { label: 'Max pace', unit: 's/km', agg: 'avg', value: typed, from: 'manual' };
      else if (f) {
        metrics.max_pace = {
          label: 'Max pace', unit: 's/km', agg: 'avg', value: Math.round(f.pace), from: f.from, basis: f.basis,
          ...(f.at !== undefined ? { max_at: Math.round(f.at) } : {}), ...(f.over_s !== undefined ? { over_s: Math.round(f.over_s) } : {}),
        };
      }
    }
  }
  // An estimate of fitness rather than a reading of the workout: taken from outside it, kept as written.
  const vo2 = kind === 'workout' ? rec.details.vo2max : null;
  if (vo2) metrics.vo2_max = { label: 'VO2max', unit: 'ml/kg/min', agg: 'avg', value: vo2.value, at: vo2.at, from: 'summary' };
  return { metrics, hr };
}

// ---------------------------------------------------------------------------------------------
// Two recordings: how well they agree
// ---------------------------------------------------------------------------------------------

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]!; sy += y[i]!; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i]! - mx, b = y[i]! - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** A grid with short holes filled from the last reading, so a device sampling every few seconds still lines up. */
function filledGrid(s: Series, from: number, to: number, step: number, maxFill: number): (number | null)[] {
  const g = bucketMeans(s, from, to, step);
  let last: number | null = null, age = 0;
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== null) { last = g[i]!; age = 0; } else if (last !== null && (age += step) <= maxFill) g[i] = last;
  }
  return g;
}

/** "About 3 bpm" and "about 7 bpm": judged on the whole number a person would read. */
function bpmVerdict(gap: number): Verdict { const g = Math.round(Math.abs(gap)); return g <= 3 ? 'match' : g <= 7 ? 'close' : 'differs'; }

/** Heart rate, test against reference, over the time both were recording. Null when they barely overlap. */
export function compareHeartRate(test: Series, reference: Series, from: number, to: number): HrAgreement | null {
  if (to - from < 120) return null;
  const BLOCK = 30;
  const a = bucketMeans(test, from, to, BLOCK), b = bucketMeans(reference, from, to, BLOCK);
  const x: number[] = [], y: number[] = [], at: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null) { x.push(a[i]!); y.push(b[i]!); at.push(from + i * BLOCK); }
  if (x.length < 4) return null;

  const stats = (idx: number[]) => {
    const diffs = idx.map((i) => x[i]! - y[i]!);
    const bias = diffs.reduce((p, q) => p + q, 0) / diffs.length;
    const mae = diffs.reduce((p, q) => p + Math.abs(q), 0) / diffs.length;
    return { diffs, bias, mae };
  };
  const all = stats(x.map((_, i) => i));
  const n = all.diffs.length;
  const rmse = Math.sqrt(all.diffs.reduce((p, q) => p + q * q, 0) / n);
  const sd = Math.sqrt(all.diffs.reduce((p, q) => p + (q - all.bias) ** 2, 0) / Math.max(1, n - 1));
  const abs = all.diffs.map(Math.abs);
  let worst = 0;
  for (let i = 1; i < n; i++) if (abs[i]! > abs[worst]!) worst = i;

  // The start of a workout is where optical sensors struggle, so it is reported on its own.
  let warmup: HrAgreement['warmup'] = null, steady: HrAgreement['steady'] = null;
  const WARMUP = 180;
  if (to - from >= 480) {
    const early = at.map((t, i) => (t < from + WARMUP ? i : -1)).filter((i) => i >= 0);
    const late = at.map((t, i) => (t >= from + WARMUP ? i : -1)).filter((i) => i >= 0);
    if (early.length >= 3 && late.length >= 6) {
      const e = stats(early), l = stats(late);
      warmup = { seconds: WARMUP, bias: r1(e.bias), typical_gap: r1(e.mae), verdict: bpmVerdict(e.mae) };
      steady = { bias: r1(l.bias), typical_gap: r1(l.mae), verdict: bpmVerdict(l.mae) };
    }
  }

  // Does the test device trail the reference? Slide it up to a minute either way and see.
  const STEP = 5;
  const gt = filledGrid(test, from, to, STEP, 15), gr = filledGrid(reference, from, to, STEP, 15);
  const at0 = (() => { const p: number[] = [], q: number[] = []; for (let i = 0; i < gt.length; i++) if (gt[i] !== null && gr[i] !== null) { p.push(gt[i]!); q.push(gr[i]!); } return pearson(p, q); })();
  let lag: number | null = null;
  if (at0 !== null && gt.length >= 60) {
    let best = at0, bestShift = 0;
    for (let shift = -12; shift <= 12; shift++) {
      if (!shift) continue;
      const p: number[] = [], q: number[] = [];
      for (let i = 0; i < gr.length; i++) { const j = i + shift; if (j >= 0 && j < gt.length && gt[j] !== null && gr[i] !== null) { p.push(gt[j]!); q.push(gr[i]!); } }
      if (p.length < 40) continue;
      const r = pearson(p, q);
      if (r !== null && r > best) { best = r; bestShift = shift; }
    }
    // Only worth saying when the two lines really do move together once shifted.
    if (bestShift !== 0 && best >= 0.6 && best - at0 >= 0.05) lag = bestShift * STEP;
  }

  const r = pearson(x, y);
  return {
    overlap_s: Math.round(to - from), blocks: n,
    bias: r1(all.bias), typical_gap: r1(all.mae), median_gap: r1(median(abs)), rmse: r1(rmse),
    r: r === null ? null : r2(r),
    within_5: r1((abs.filter((d) => d <= 5).length / n) * 100),
    within_10: r1((abs.filter((d) => d <= 10).length / n) * 100),
    max_gap: r1(all.diffs[worst]!), max_gap_at: at[worst]!,
    loa_low: r1(all.bias - 1.96 * sd), loa_high: r1(all.bias + 1.96 * sd),
    warmup, steady, lag_s: lag,
    slow_start: Boolean(warmup && steady && Math.abs(warmup.bias) >= 8 && Math.abs(warmup.bias) >= 2 * Math.abs(steady.bias)),
    verdict: bpmVerdict(all.mae),
  };
}

function kappaOf(confusion: number[][]): number | null {
  const k = confusion.length;
  let total = 0, agree = 0;
  const rows = new Array<number>(k).fill(0), cols = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { const c = confusion[i]![j]!; total += c; rows[i]! += c; cols[j]! += c; if (i === j) agree += c; }
  if (!total) return null;
  const po = agree / total;
  let pe = 0;
  for (let i = 0; i < k; i++) pe += (rows[i]! / total) * (cols[i]! / total);
  return pe >= 1 ? null : r2((po - pe) / (1 - pe));
}

/** Epoch by epoch over the whole night either device recorded. Outside its own recording a device counts as awake. */
export function compareSleep(test: Rec, reference: Rec): SleepAgreement | null {
  if (!test.stages || !reference.stages) return null;
  const from = Math.min(test.start, reference.start), to = Math.max(test.end, reference.end);
  const a = epochsOf(test.stages, from, to), b = epochsOf(reference.stages, from, to);
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  // The devices must both tell sleep from wake; "in bed" alone says neither.
  const knows = (e: Uint8Array) => e.some((c) => c >= 3);
  if (!knows(a) || !knows(b)) return null;
  const staged = (r: Rec) => Boolean(r.details.sleep?.has_stages);
  const useStages = staged(test) && staged(reference);
  // 0 awake, 1 light (core, or asleep without a stage), 2 deep, 3 REM.
  const cls = (code: number) => (code < 3 ? 0 : code === 5 ? 2 : code === 6 ? 3 : 1);
  const confusion = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  let sw = 0, refSleep = 0, refWake = 0, bothSleep = 0, bothWake = 0, stageAgree = 0;
  for (let i = 0; i < n; i++) {
    const t = cls(a[i]!), r = cls(b[i]!);
    confusion[r]![t]! += 1;
    const ts = t > 0, rs = r > 0;
    if (ts === rs) sw++;
    if (rs) { refSleep++; if (ts) bothSleep++; } else { refWake++; if (!ts) bothWake++; }
    if (t === r) stageAgree++;
  }
  const two = [[confusion[0]![0]!, confusion[0]!.slice(1).reduce((p, q) => p + q, 0)], [confusion.slice(1).reduce((p, row) => p + row[0]!, 0), bothSleep]];
  return {
    epochs: n,
    sleep_wake_pct: r1((sw / n) * 100),
    sensitivity: refSleep ? r1((bothSleep / refSleep) * 100) : null,
    specificity: refWake ? r1((bothWake / refWake) * 100) : null,
    stage_pct: useStages ? r1((stageAgree / n) * 100) : null,
    kappa: kappaOf(useStages ? confusion : two),
    labels: useStages ? ['Awake', 'Light', 'Deep', 'REM'] : ['Awake', 'Asleep'],
    confusion: useStages ? confusion : two,
  };
}

/** How far apart two numbers may be and still count as the same, by what they measure. */
function judge(key: string, unit: string, kind: Kind, reference: number, test: number): Verdict {
  const diff = Math.abs(test - reference);
  if (unit === 'clock') {
    const [match, close] = kind === 'sleep' ? [600, 1800] : [60, 180];
    return diff <= match ? 'match' : diff <= close ? 'close' : 'differs';
  }
  if (unit === 'bpm') return bpmVerdict(diff);
  if (kind === 'sleep' && unit === 's') return diff <= 600 ? 'match' : diff <= 1800 ? 'close' : 'differs';
  if (key === 'awakenings') return diff <= 1 ? 'match' : diff <= 3 ? 'close' : 'differs';
  if (unit === '%') return diff <= 3 ? 'match' : diff <= 7 ? 'close' : 'differs';
  if (reference === 0) return test === 0 ? 'match' : 'differs';
  const pct = diff / Math.abs(reference);
  return pct <= 0.02 ? 'match' : pct <= 0.05 ? 'close' : 'differs';
}

const ROW_ORDER = [
  'start', 'end', 'duration', 'time_in_bed', 'total_sleep', 'sleep_latency', 'waso', 'awakenings', 'sleep_efficiency',
  'deep_sleep', 'core_sleep', 'rem_sleep', 'unstaged_sleep',
  'distance', 'pace', 'max_pace', 'speed', 'active_energy', 'basal_energy', 'steps', 'cadence', 'heart_rate', 'heart_rate_min', 'heart_rate_max', 'vo2_max',
];

/** How a device's fastest pace was found, in a few words. */
function paceSource(m: MetricValue): string {
  if (m.from === 'manual') return 'entered by hand';
  if (m.from === 'summary') return 'its own top speed';
  const over = m.over_s !== undefined ? ` ${m.over_s < 90 ? `${m.over_s} s` : `${Math.round(m.over_s / 60)} min`}` : '';
  return m.basis === 'route' ? `fastest${over} of its GPS track` : m.basis === 'distance' ? `fastest${over} of its distance readings` : 'its top speed reading';
}

/** Every number both devices reported, side by side, with a verdict on each. */
export function compareRows(test: Rec, reference: Rec, kind: Kind, m: Map<string, Record<string, MetricValue>>): Row[] {
  const tm = m.get(test.id) ?? {}, rm = m.get(reference.id) ?? {};
  const rows: Row[] = [];
  const both = test.logged && reference.logged;
  const add = (key: string, label: string, unit: string, r: number | undefined, t: number | undefined, note?: string) => {
    if (r === undefined && t === undefined) return;
    // A one-sided row only says something when both devices logged the session themselves.
    if ((r === undefined || t === undefined) && !both) return;
    const row: Row = { key, label, unit, reference: r ?? null, test: t ?? null, diff: null, pct: null, verdict: r === undefined ? 'only_test' : t === undefined ? 'only_reference' : 'match' };
    if (r !== undefined && t !== undefined) {
      row.diff = r3(t - r);
      row.pct = unit === 'clock' || r === 0 ? null : r1(((t - r) / Math.abs(r)) * 100);
      row.verdict = judge(key, unit, kind, r, t);
    }
    if (note) row.note = note;
    rows.push(row);
  };

  if (both) {
    add('start', kind === 'sleep' ? 'Bedtime' : 'Start', 'clock', reference.start, test.start);
    add('end', kind === 'sleep' ? 'Wake time' : 'End', 'clock', reference.end, test.end);
  }
  const keys = new Set([...Object.keys(tm), ...Object.keys(rm)]);
  for (const key of keys) {
    const t = tm[key], r = rm[key];
    const info = (t ?? r)!;
    const typed = key === 'distance' || key === 'active_energy' ? [t?.from === 'manual' ? test.label : null, r?.from === 'manual' ? reference.label : null].filter(Boolean) : [];
    let note = typed.length ? `${typed.join(' and ')}: entered by hand, not written to Apple Health.` : undefined;
    if (key === 'max_pace') note = [[reference, r], [test, t]].filter(([, m]) => m).map(([rec, m]) => `${(rec as Rec).label}: ${paceSource(m as MetricValue)}`).join('. ') + '.';
    if (key === 'vo2_max') note = 'Each app’s own estimate nearest the workout (Apple Health calls it Cardio Fitness), not measured during it.';
    add(key, key === 'heart_rate' ? 'Average heart rate' : info.label, info.unit, r?.value, t?.value, note);
    if (key === 'heart_rate') {
      add('heart_rate_min', 'Minimum heart rate', info.unit, r?.min, t?.min);
      add('heart_rate_max', 'Maximum heart rate', info.unit, r?.max, t?.max);
    }
  }

  // Calories depend on the body weight each app was given; with different weights they cannot agree.
  const tw = test.details.profile?.weight_kg, rw = reference.details.profile?.weight_kg;
  if (both && tw && rw && Math.abs(tw - rw) / rw > 0.05) {
    for (const row of rows) {
      if ((row.key === 'active_energy' || row.key === 'basal_energy') && row.reference !== null && row.test !== null) {
        row.verdict = 'not_comparable';
        row.note = `The apps use different body weights: ${r1(rw)} kg and ${r1(tw)} kg.`;
      }
    }
  }

  const rank = (key: string) => { const i = ROW_ORDER.indexOf(key); return i === -1 ? ROW_ORDER.length : i; };
  return rows.sort((p, q) => rank(p.key) - rank(q.key) || p.label.localeCompare(q.label));
}

// ---------------------------------------------------------------------------------------------
// The whole session
// ---------------------------------------------------------------------------------------------

const minutes = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const lowHigh = (bias: number) => `${Math.round(Math.abs(bias))} bpm ${bias < 0 ? 'low' : 'high'}`;

function findingsFor(pair: Pair, test: Rec, reference: Rec, hr: Map<string, HrQuality | null>, metrics: Map<string, Record<string, MetricValue>>): Finding[] {
  const out: Finding[] = [];
  const name = test.label, ref = reference.label;
  const q = hr.get(test.id);
  const a = pair.hr;

  if (a) {
    const where = Math.abs(a.bias) >= 1 ? `reads ${lowHigh(a.bias)} on average` : 'leaning neither high nor low';
    out.push({
      level: a.verdict === 'match' ? 'good' : a.verdict === 'close' ? 'info' : 'warn',
      title: a.verdict === 'match' ? 'Heart rate tracks the reference' : a.verdict === 'close' ? 'Heart rate is close to the reference' : 'Heart rate differs from the reference',
      detail: `Typical gap ${Math.round(a.typical_gap)} bpm against ${ref}, ${where}. ${Math.round(a.within_5)}% of half-minutes are within 5 bpm${a.r !== null ? `, correlation ${a.r}` : ''}.`,
    });
    if (a.slow_start && a.warmup && a.steady) {
      out.push({ level: 'warn', title: 'Slow to lock on at the start', detail: `${name} reads ${lowHigh(a.warmup.bias)} in the first 3 minutes, then ${Math.abs(a.steady.bias) < 0.5 ? 'level with' : lowHigh(a.steady.bias) + ' against'} ${ref} for the rest.` });
    }
    if (a.lag_s !== null && a.lag_s >= 10) out.push({ level: 'info', title: 'Heart rate trails the reference', detail: `${name} follows changes about ${a.lag_s} s after ${ref}.` });
  }
  if (q && q.held_pct >= 5) {
    const longest = q.holds.reduce((p, h) => (h.t1 - h.t0 > p.t1 - p.t0 ? h : p), q.holds[0]!);
    out.push({ level: 'warn', title: 'Heart rate holds a stale value', detail: `${name} reported the exact same bpm for 40 s or more ${q.holds.length} time${q.holds.length === 1 ? '' : 's'}: ${mmss(q.held_s)} in total, ${Math.round(q.held_pct)}% of the session. The longest held ${longest.value} bpm for ${mmss(longest.t1 - longest.t0)}.` });
  }
  if (q && q.gap_s >= 60) out.push({ level: 'warn', title: 'Heart rate dropouts', detail: `${name} has ${q.gaps.length} gap${q.gaps.length === 1 ? '' : 's'} in its heart rate, ${mmss(q.gap_s)} in total.` });
  if (q && test.logged && q.first_after_s >= 60) out.push({ level: 'info', title: 'First heart rate reading came late', detail: `${name} wrote its first reading ${mmss(q.first_after_s)} after the session started.` });

  const tMax = metrics.get(test.id)?.heart_rate?.max, rMax = metrics.get(reference.id)?.heart_rate?.max;
  if (a && tMax !== undefined && rMax !== undefined && rMax - tMax >= 10) out.push({ level: 'warn', title: 'Misses the peaks', detail: `${name} peaks at ${Math.round(tMax)} bpm where ${ref} reaches ${Math.round(rMax)}.` });

  for (const row of pair.rows) {
    if (row.verdict === 'not_comparable' && row.key === 'active_energy') out.push({ level: 'info', title: 'Calories are not comparable', detail: `${row.note} Set the same weight in both apps and repeat the test.` });
    else if (row.key === 'distance' && row.verdict === 'differs' && row.pct !== null) out.push({ level: 'warn', title: 'Distance differs', detail: `${name} measured ${r2(row.test!)} km against ${r2(row.reference!)} km on ${ref} (${row.pct > 0 ? '+' : ''}${row.pct}%).` });
    else if (row.key === 'total_sleep' && row.verdict === 'differs' && row.diff !== null) out.push({ level: 'warn', title: 'Time asleep differs', detail: `${name} counted ${Math.round(Math.abs(row.diff) / 60)} minutes ${row.diff > 0 ? 'more' : 'less'} sleep than ${ref}.` });
  }
  const s = pair.sleep;
  if (s) {
    out.push({
      level: s.sleep_wake_pct >= 90 ? 'good' : s.sleep_wake_pct >= 80 ? 'info' : 'warn',
      title: 'Asleep or awake',
      detail: `${name} and ${ref} agree on ${s.sleep_wake_pct}% of the night${s.specificity !== null ? `; ${name} catches ${s.specificity}% of the time ${ref} has as awake` : ''}.`,
    });
    if (s.stage_pct !== null) out.push({ level: s.stage_pct >= 70 ? 'good' : s.stage_pct >= 55 ? 'info' : 'warn', title: 'Sleep stages', detail: `The two agree on the stage for ${s.stage_pct}% of the night${s.kappa !== null ? ` (kappa ${s.kappa})` : ''}.` });
  }
  return out;
}

/**
 * What could not be compared, and why. A session with Luna and a reference in it but no heart rate
 * line for one of them, or no side by side at all, should say so rather than leave a blank.
 */
export function gapsFor(recs: Rec[], kind: Kind, pairs: Pair[], hr: Map<string, HrQuality | null>): string[] {
  const out: string[] = [];
  const what = kind === 'sleep' ? 'night' : 'workout';
  const devices = recs.filter((r) => r.tag !== 'phone');
  const byRank = [...devices].sort((a, b) => Number(b.logged) - Number(a.logged) || referenceRank(a.tag) - referenceRank(b.tag));
  const test = devices.find((r) => r.tag === TEST_TAG) ?? (devices.length > 1 ? byRank[1] : undefined);
  const reference = byRank.find((r) => r.id !== test?.id && r.tag !== TEST_TAG);
  if (!test) return out;
  if (!reference) {
    if (test.tag === TEST_TAG) out.push(`No other device recorded this ${what}, so there is nothing to compare ${test.label} with.`);
    return out;
  }
  const pair = pairs.find((p) => p.test === test.id && p.reference === reference.id);
  for (const r of [test, reference]) {
    if (!r.logged) out.push(kind === 'sleep'
      ? `${r.label} did not record this night itself; it only has readings it wrote to Apple Health during it.`
      : `${r.label} did not log this workout itself, so it has no duration, distance or calories for it; only what it wrote to Apple Health during it.`);
  }
  // Two devices put in one session by hand, whose recordings do not line up in time.
  if (test.logged && reference.logged && overlapShare(test, reference) < 0.5) {
    const lead = test.start - reference.start;
    const apart = Math.min(test.end, reference.end) <= Math.max(test.start, reference.start);
    out.push(`${test.label}'s recording starts ${minutes(Math.abs(lead))} ${lead < 0 ? 'before' : 'after'} ${reference.label}'s${apart ? ' and the two do not overlap' : ''}. Either one clock is off or these are two separate ${what}s; readings are compared at the times each device wrote, so they do not line up.`);
  }
  if (kind === 'workout') {
    const has = (r: Rec) => Boolean(hr.get(r.id));
    if (!has(test) && !has(reference)) out.push('Neither device wrote heart rate to Apple Health for this time, so there is no heart rate to compare.');
    else if (!has(reference)) out.push(`${reference.label} wrote no heart rate to Apple Health for this time, so heart rate cannot be compared.`);
    else if (!has(test)) out.push(`${test.label} wrote no heart rate to Apple Health for this time, so heart rate cannot be compared.`);
    else if (!pair?.hr) out.push('The two heart rate traces overlap too briefly to compare.');
  } else if (!pair?.sleep) {
    const blind = [test, reference].filter((r) => r.logged && r.stages && !r.stages.runs.some((x) => x[2] !== 'in_bed' && x[2] !== 'awake'));
    for (const r of blind) out.push(`${r.label} only recorded time in bed, so time asleep and stages cannot be compared.`);
  }
  return out;
}

/**
 * The same, in a few words, for a session with nothing compared at all. Devices go by brand here
 * ("Fitbit"), as the list shows them, unless someone gave the device a name of its own.
 */
export function whyNothing(recs: Rec[], kind: Kind, hr: Map<string, HrQuality | null>): string {
  const name = (r: Rec) => (r.label === r.source ? tagLabel(r.tag) : r.label);
  const what = kind === 'sleep' ? 'night' : 'workout';
  const devices = recs.filter((r) => r.tag !== 'phone');
  const logged = devices.filter((r) => r.logged);
  const luna = devices.find((r) => r.tag === TEST_TAG);
  const other = [...devices].sort((a, b) => Number(b.logged) - Number(a.logged) || referenceRank(a.tag) - referenceRank(b.tag)).find((r) => r.id !== luna?.id);
  if (!luna) return logged.length > 1 ? 'Nothing in common to compare' : `Only ${name(logged[0] ?? devices[0] ?? recs[0]!)} recorded it: no Luna`;
  if (!other) return 'Only Luna recorded it';
  const parts: string[] = [];
  for (const r of [luna, other]) if (!r.logged) parts.push(`${name(r)} did not log this ${what}`);
  if (kind === 'workout') {
    const has = (r: Rec) => Boolean(hr.get(r.id));
    if (!has(luna) && !has(other)) parts.push('neither has heart rate');
    else if (!has(other)) parts.push(`${name(other)} has no heart rate for it`);
    else if (!has(luna)) parts.push(`${name(luna)} has no heart rate for it`);
  }
  return parts.length ? parts.join('; ') : 'Nothing in common to compare';
}

/** The order devices are shown in: the one under test, then the ones that logged the session (best reference first), then background sources. */
export function displayOrder<T extends { tag: string; logged: boolean }>(recs: T[]): T[] {
  const rank = (r: T) => (r.tag === TEST_TAG ? 0 : r.logged ? 1 : 2);
  return [...recs].sort((a, b) => rank(a) - rank(b) || referenceRank(a.tag) - referenceRank(b.tag));
}

/**
 * Works out everything for a session: each recording's numbers, each test-against-reference
 * comparison, and what is worth pointing out.
 */
export function analyzeSession(recs: Rec[], kind: Kind): {
  window: { start: number; end: number };
  metrics: Map<string, Record<string, MetricValue>>;
  hr: Map<string, HrQuality | null>;
  activity: string | null;
  summary: Summary;
} {
  const logged = recs.filter((r) => r.logged);
  const spanOf = logged.length ? logged : recs;
  const window = { start: Math.min(...spanOf.map((r) => r.start)), end: Math.max(...spanOf.map((r) => r.end)) };

  const metrics = new Map<string, Record<string, MetricValue>>();
  const hr = new Map<string, HrQuality | null>();
  for (const rec of recs) {
    const m = recordingMetrics(rec, kind, window);
    metrics.set(rec.id, m.metrics); hr.set(rec.id, m.hr);
  }

  // Luna is what is being tested. Without it, the best reference device stands and the others are tested against it.
  const byRank = [...recs].sort((a, b) => Number(b.logged) - Number(a.logged) || referenceRank(a.tag) - referenceRank(b.tag));
  const lunas = recs.filter((r) => r.tag === TEST_TAG);
  const tests = lunas.length ? lunas : byRank.slice(1);
  const pairs: Pair[] = [];
  for (const test of tests) {
    const references = lunas.length ? byRank.filter((r) => r.tag !== TEST_TAG) : byRank.slice(0, 1);
    for (const reference of references) {
      if (reference.id === test.id) continue;
      const from = Math.max(test.logged ? test.start : window.start, reference.logged ? reference.start : window.start);
      const to = Math.min(test.logged ? test.end : window.end, reference.logged ? reference.end : window.end);
      const th = test.series.heart_rate, rh = reference.series.heart_rate;
      const pair: Pair = {
        test: test.id, reference: reference.id,
        hr: kind === 'workout' && th && rh ? compareHeartRate(th, rh, from, to) : null,
        sleep: kind === 'sleep' ? compareSleep(test, reference) : null,
        rows: compareRows(test, reference, kind, metrics),
      };
      // A source that only has background samples is compared when there is a trace to compare;
      // its pocket step count against a watch's workout is not a benchmark.
      if (pair.hr || pair.sleep || ((test.logged || test.tag === TEST_TAG) && reference.logged && pair.rows.length)) pairs.push(pair);
    }
  }
  const primaryIndex = pairs.findIndex((p) => p.hr || p.sleep);
  const primary = pairs.length ? (primaryIndex === -1 ? 0 : primaryIndex) : null;
  const byId = new Map(recs.map((r) => [r.id, r]));
  const lead = primary === null ? null : pairs[primary]!;
  const findings = lead ? findingsFor(lead, byId.get(lead.test)!, byId.get(lead.reference)!, hr, metrics) : [];

  const headlineKeys = kind === 'sleep' ? ['total_sleep', 'sleep_latency', 'deep_sleep', 'rem_sleep'] : ['distance', 'active_energy', 'duration', 'steps'];
  const activity = (byRank.find((r) => r.logged && r.activity && r.activity !== 'other') ?? byRank.find((r) => r.logged))?.activity ?? null;
  return {
    window, metrics, hr, activity,
    summary: {
      version: ANALYSIS_VERSION, kind,
      recordings: displayOrder(recs).map((r) => ({ id: r.id, source: r.source, tag: r.tag, label: r.label, logged: r.logged, hr: Boolean(hr.get(r.id)) })),
      pairs, primary, findings,
      gaps: gapsFor(recs, kind, pairs, hr),
      why: pairs.length ? null : whyNothing(recs, kind, hr),
      zone_labels: ZONE_LABELS,
      headline: {
        test: lead ? byId.get(lead.test)!.tag : null,
        reference: lead ? byId.get(lead.reference)!.tag : null,
        hr: lead?.hr ? { typical_gap: lead.hr.typical_gap, bias: lead.hr.bias, r: lead.hr.r, verdict: lead.hr.verdict } : null,
        sleep: lead?.sleep ? { sleep_wake_pct: lead.sleep.sleep_wake_pct, stage_pct: lead.sleep.stage_pct } : null,
        rows: lead ? lead.rows.filter((r) => headlineKeys.includes(r.key) && r.diff !== null).sort((a, b) => headlineKeys.indexOf(a.key) - headlineKeys.indexOf(b.key)).map(({ key, label, unit, diff, pct, verdict }) => ({ key, label, unit, diff, pct, verdict })) : [],
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Which workouts in an export are the same session
// ---------------------------------------------------------------------------------------------

export interface Candidate { key: string; kind: Kind; source: string; activity?: string | null; start: number; end: number }
export interface CandidateGroup { kind: Kind; start: number; end: number; members: Candidate[] }

/** Share of the shorter of two spans that the two have in common. */
export function overlapShare(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const common = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  return common <= 0 ? 0 : common / shorter;
}

/**
 * Two sessions that do not overlap enough to have been grouped, but probably are one: they start
 * within 20 minutes of each other and are of similar length. This is what a device with a clock
 * that is off looks like. Only ever a suggestion to a person, or a one-time clean-up they asked for.
 */
export function looksLikeSameSession(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const la = Math.max(1, a.end - a.start), lb = Math.max(1, b.end - b.start);
  return Math.abs(a.start - b.start) <= 20 * 60 && Math.min(la, lb) / Math.max(la, lb) >= 0.6;
}

/**
 * Two devices recording the same workout start and stop within moments of each other, so workouts
 * from different sources that mostly overlap are one session. Two workouts from the same source
 * never are: that is a device logging two things.
 *
 * The closest matches are joined first (closest = most of their combined span in common), so a
 * watch that logged the second half of a long session pairs with the strap that logged the same
 * half, not with whatever happens to span both.
 */
export function groupCandidates(candidates: Candidate[]): CandidateGroup[] {
  const list = [...candidates].sort((a, b) => a.start - b.start || a.end - b.end);
  const group = list.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
  const sources = list.map((c) => new Set([c.source]));

  const links: { a: number; b: number; closeness: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j]!.start < list[i]!.end; j++) {
      const x = list[i]!, y = list[j]!;
      if (x.kind !== y.kind || x.source === y.source || overlapShare(x, y) < 0.5) continue;
      const common = Math.min(x.end, y.end) - Math.max(x.start, y.start);
      const combined = Math.max(x.end, y.end) - Math.min(x.start, y.start);
      links.push({ a: i, b: j, closeness: common / Math.max(1, combined) });
    }
  }
  links.sort((p, q) => q.closeness - p.closeness);
  for (const { a, b } of links) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    const sa = sources[ra]!, sb = sources[rb]!;
    if ([...sb].some((src) => sa.has(src))) continue;
    for (const src of sb) sa.add(src);
    group[rb] = ra;
  }

  const byRoot = new Map<number, CandidateGroup>();
  list.forEach((c, i) => {
    const root = find(i);
    const g = byRoot.get(root);
    if (g) { g.members.push(c); g.start = Math.min(g.start, c.start); g.end = Math.max(g.end, c.end); }
    else byRoot.set(root, { kind: c.kind, start: c.start, end: c.end, members: [c] });
  });
  return [...byRoot.values()].sort((p, q) => p.start - q.start || p.end - q.end);
}
