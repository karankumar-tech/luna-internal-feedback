import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
// The browser's export reader: plain JavaScript, no DOM, so it runs here as it runs on the page.
// @ts-expect-error no type declarations for the page script
import { buildNights, extractSessions, guessTester, openExport, parseDate, parseDevice, parseGpx, scanExport } from '../../src/pages/scripts/health-export.js';
import {
  analyzeSession, buildStages, compareHeartRate, compareSleep, groupCandidates, heartRateQuality, normalizeRecording, normalizeSeries,
  sleepMetrics, type IncomingRecording, type Rec, type Series,
} from '../../src/modules/benchmarks/analyze.js';
import { activityKey, activityLabel, guessTag, metricOf } from '../../src/modules/benchmarks/metrics.js';

// ---------------------------------------------------------------------------------------------
// A small export, shaped like the real thing: a document type block, re-synced duplicates, two
// devices on one run, the phone counting steps in the background, and two nights.
// ---------------------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
/** Seconds after 2026-09-29 00:00 IST -> the export's date format. */
const at = (s: number) => { const d = 29 + Math.floor(s / 86400); const r = ((s % 86400) + 86400) % 86400; return `2026-09-${pad(d)} ${pad(Math.floor(r / 3600))}:${pad(Math.floor((r % 3600) / 60))}:${pad(r % 60)} +0530`; };
const RUN = 18 * 3600; // 18:00 IST
const IST_MIDNIGHT = Date.UTC(2026, 8, 28, 18, 30) / 1000; // 2026-09-29 00:00 +0530

function sampleExport(): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE HealthData [',
    '<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>',
    '<!ATTLIST Record type CDATA #REQUIRED value CDATA #IMPLIED>',
    ']>',
    '<HealthData locale="en_IN">',
    ' <ExportDate value="2026-09-30 14:12:05 +0530"/>',
    ' <Me HKCharacteristicTypeIdentifierDateOfBirth="2000-01-01"/>',
  ];
  const rec = (type: string, source: string, unit: string, a: number, b: number, value: number | string, extra = '') =>
    out.push(` <Record type="${type}" sourceName="${source}" sourceVersion="1190"${extra} unit="${unit}" creationDate="${at(b)}" startDate="${at(a)}" endDate="${at(b)}" value="${value}"/>`);
  const HR = 'HKQuantityTypeIdentifierHeartRate';
  // Polar: one reading a second for 10 minutes, every record written three times (as Polar Flow re-syncs).
  for (let pass = 0; pass < 3; pass++) for (let t = 0; t <= 600; t++) rec(HR, 'Polar Flow', 'count/min', RUN + t, RUN + t, 120 + Math.round(t / 20));
  // Luna: a reading every 2 s, 4 bpm low, and stuck on 131 for a minute.
  for (let t = 0; t <= 590; t += 2) rec(HR, 'Luna', 'count/min', RUN + 5 + t, RUN + 5 + t, t >= 300 && t < 360 ? 131 : 116 + Math.round(t / 20));
  rec('HKQuantityTypeIdentifierBodyMass', 'Polar Flow', 'kg', RUN - 3600, RUN - 3600, 80);
  rec('HKQuantityTypeIdentifierBodyMass', 'Luna', 'lb', RUN - 3600, RUN - 3600, 101.4);
  // The phone in a pocket: one step record half inside the run, and noise that must be ignored.
  const phone = ' device="&lt;&lt;HKDevice: 0x1&gt;, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone16,2, software:26.6&gt;"';
  rec('HKQuantityTypeIdentifierStepCount', 'Navay’s iPhone', 'count', RUN - 300, RUN + 300, 1000, phone);
  rec('HKQuantityTypeIdentifierHeadphoneAudioExposure', 'Navay’s iPhone', 'dBASPL', RUN, RUN + 60, 71, phone);
  rec(HR, 'Polar Flow', 'count/min', RUN + 7200, RUN + 7200, 60); // long after the run
  // Two nights from the phone, one from Luna with stages.
  const sleep = (source: string, a: number, b: number, value: string) => out.push(` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${source}" sourceVersion="1" creationDate="${at(b)}" startDate="${at(a)}" endDate="${at(b)}" value="HKCategoryValueSleepAnalysis${value}"/>`);
  sleep('Navay’s iPhone', -3600, 6 * 3600, 'InBed');
  sleep('Navay’s iPhone', 23 * 3600, 30 * 3600, 'InBed');
  sleep('Luna', 23 * 3600 + 600, 23 * 3600 + 1800, 'Awake');
  sleep('Luna', 23 * 3600 + 1800, 25 * 3600, 'AsleepCore');
  sleep('Luna', 25 * 3600, 26 * 3600, 'AsleepDeep');
  sleep('Luna', 26 * 3600, 26 * 3600 + 300, 'Awake');
  sleep('Luna', 26 * 3600 + 300, 29 * 3600, 'AsleepREM');
  sleep('Luna', 29 * 3600, 29 * 3600, 'AsleepCore'); // empty record: ignored
  const workout = (source: string, a: number, b: number, km: number, kcal: number, route = '') => {
    out.push(` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="${(b - a) / 60}" durationUnit="min" sourceName="${source}" sourceVersion="1190" creationDate="${at(b)}" startDate="${at(a)}" endDate="${at(b)}">`);
    for (let twice = 0; twice < 2; twice++) {
      out.push('  <MetadataEntry key="HKIndoorWorkout" value="0"/>');
      out.push(`  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="${at(a)}" endDate="${at(b)}" sum="${kcal}" unit="kcal"/>`);
      out.push(`  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="${at(a)}" endDate="${at(b)}" sum="${km}" unit="km"/>`);
    }
    out.push(`  <WorkoutEvent type="HKWorkoutEventTypePause" date="${at(a + 60)}" duration="0.5" durationUnit="min"/>`);
    if (route) out.push(`  <WorkoutRoute sourceName="${source}"><FileReference path="${route}"/></WorkoutRoute>`);
    out.push(' </Workout>');
  };
  workout('Polar Flow', RUN, RUN + 600, 2.0, 150);
  workout('Luna', RUN + 5, RUN + 595, 1.96, 60, '/workout-routes/route_2026-09-29_6.00pm.gpx');
  out.push('</HealthData>');
  return out.join('\n') + '\n';
}

const GPX = `<?xml version="1.0"?><gpx><trk><trkseg>
<trkpt lon="77.4500" lat="28.6700"><ele>210.0</ele><time>2026-09-29T12:30:05Z</time><extensions><speed>2.1</speed></extensions></trkpt>
<trkpt lon="77.4510" lat="28.6700"><ele>210.5</ele><time>2026-09-29T12:31:05Z</time><extensions><speed>2.4</speed></extensions></trkpt>
<trkpt lon="77.4510" lat="28.6710"><ele>211.0</ele><time>2026-09-29T12:32:05Z</time><extensions><speed>2.2</speed></extensions></trkpt>
</trkseg></trk></gpx>`;

/** A file that hands out its bytes a few at a time, so every tag gets cut across chunks somewhere. */
function drip(text: string, chunk: number) {
  const bytes = new TextEncoder().encode(text);
  const blob = new Blob([bytes]);
  return {
    name: 'export.xml', size: blob.size,
    slice: (a: number, b: number) => blob.slice(a, b),
    stream: () => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); } }),
  };
}

describe('reading an Apple Health export', () => {
  it('reads dates in the export’s own format, with their offset', () => {
    expect(parseDate('2026-09-29 18:01:02 +0530')).toBe(Date.UTC(2026, 8, 29, 12, 31, 2) / 1000);
    expect(parseDate('2026-01-01 00:00:00 -0800')).toBe(Date.UTC(2026, 0, 1, 8, 0, 0) / 1000);
    expect(Number.isNaN(parseDate('soon'))).toBe(true);
  });

  it('pulls the hardware out of a device description', () => {
    expect(parseDevice('<<HKDevice: 0x7d>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.1>'))
      .toEqual({ name: 'Apple Watch', manufacturer: 'Apple Inc.', model: 'Watch', hardware: 'Watch6,1', software: '10.1' });
    expect(parseDevice(undefined)).toBeNull();
  });

  it('guesses the wearer from the phone’s name', () => {
    expect(guessTester(['Polar Flow', 'Navay’s iPhone'])).toBe('Navay');
    expect(guessTester(['Polar Flow'])).toBe('');
  });

  it('lists workouts, nights, sources and body profiles, however the file is cut into chunks', async () => {
    const xml = sampleExport();
    for (const chunk of [7, 1000, 1 << 20]) {
      const scan = await scanExport(await openExport(drip(xml, chunk)));
      expect(scan.offsetMin).toBe(330);
      expect(scan.tester).toBe('Navay');
      expect(scan.workouts.map((w: { source: string }) => w.source)).toEqual(['Polar Flow', 'Luna']);
      const polar = scan.workouts[0];
      expect(polar).toMatchObject({ activity: 'HKWorkoutActivityTypeRunning', start: IST_MIDNIGHT + RUN, end: IST_MIDNIGHT + RUN + 600, duration: 10 });
      // The export repeats a workout's children; each statistic is kept once.
      expect(polar.stats).toHaveLength(2);
      expect(polar.metadata).toEqual({ HKIndoorWorkout: '0' });
      expect(polar.events).toHaveLength(1);
      expect(scan.workouts[1].routes).toEqual(['/workout-routes/route_2026-09-29_6.00pm.gpx']);
      expect(scan.nights.map((n: { source: string; segments: unknown[] }) => [n.source, n.segments.length])).toEqual([['Navay’s iPhone', 1], ['Navay’s iPhone', 1], ['Luna', 5]]);
      expect(scan.profiles['Polar Flow'].weight).toMatchObject({ value: 80, unit: 'kg' });
      expect(scan.sources.find((s: { name: string }) => s.name === 'Polar Flow')).toMatchObject({ heartRate: 3 * 601 + 1, workouts: 1 });
    }
  });

  it('collects only what was recorded during the chosen session, once', async () => {
    const src = await openExport(drip(sampleExport(), 4096));
    const scan = await scanExport(src);
    const [polar, luna] = scan.workouts;
    const [payload] = await extractSessions(src, [{ id: 0, kind: 'workout', start: polar.start, end: polar.end, members: [polar, luna] }], scan);
    expect(payload).toMatchObject({ kind: 'workout', start: polar.start, end: polar.end, utc_offset_min: 330 });
    const by = Object.fromEntries(payload.recordings.map((r: IncomingRecording) => [r.source, r]));
    expect(Object.keys(by)).toEqual(['Polar Flow', 'Luna', 'Navay’s iPhone']);
    // Three synced copies of each reading count once, and the reading two hours later is left out.
    expect(by['Polar Flow'].samples.HKQuantityTypeIdentifierHeartRate.v).toHaveLength(601);
    expect(by['Polar Flow'].samples.HKQuantityTypeIdentifierHeartRate.e).toBeNull();
    expect(by['Polar Flow'].profile).toEqual({ weight_kg: 80 });
    expect(by.Luna.profile).toEqual({ weight_kg: 46 });
    expect(by.Luna.workout.stats).toHaveLength(2);
    // The phone logged no workout: it is background, with its steps and without the headphone noise.
    expect(by['Navay’s iPhone'].logged).toBe(false);
    expect(Object.keys(by['Navay’s iPhone'].samples)).toEqual(['HKQuantityTypeIdentifierStepCount']);
    expect(by['Navay’s iPhone'].device).toMatchObject({ name: 'iPhone', hardware: 'iPhone16,2' });
  });

  it('keeps only vitals for a night', async () => {
    const src = await openExport(drip(sampleExport(), 4096));
    const scan = await scanExport(src);
    const night = scan.nights[2];
    const [payload] = await extractSessions(src, [{ id: 0, kind: 'sleep', start: night.start, end: night.end, members: [night] }], scan);
    expect(payload.recordings).toHaveLength(1);
    expect(payload.recordings[0].sleep.segments).toHaveLength(5);
  });

  it('reads the zip the phone shares: picks export.xml over the clinical copy, and follows route files', async () => {
    const zip = zipSync({
      'apple_health_export/export_cda.xml': strToU8('<ClinicalDocument>' + 'x'.repeat(50_000) + '</ClinicalDocument>'),
      'apple_health_export/export.xml': strToU8(sampleExport()),
      'apple_health_export/workout-routes/route_2026-09-29_6.00pm.gpx': [strToU8(GPX), { level: 0 }],
    });
    const src = await openExport(new Blob([zip]));
    expect(src).toMatchObject({ kind: 'zip', routeCount: 1 });
    const scan = await scanExport(src);
    expect(scan.workouts).toHaveLength(2);
    const [polar, luna] = scan.workouts;
    const [payload] = await extractSessions(src, [{ id: 0, kind: 'workout', start: polar.start, end: polar.end, members: [polar, luna] }], scan);
    const route = payload.recordings.find((r: IncomingRecording) => r.source === 'Luna').route;
    expect(route).toMatchObject({ points: 3, t: [0, 60, 120], lat: [28.67, 28.67, 28.671] });
    expect(payload.recordings.find((r: IncomingRecording) => r.source === 'Polar Flow').route).toBeUndefined();
  });

  it('says what is wrong with a file that is not an export', async () => {
    await expect(openExport(new Blob(['just some text']))).rejects.toThrow(/does not look like an Apple Health export/);
    await expect(openExport(new Blob(['<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3">']))).rejects.toThrow(/export_cda\.xml/);
    await expect(openExport(new Blob([zipSync({ 'notes.txt': strToU8('hello') })]))).rejects.toThrow(/No export\.xml/);
  });

  it('groups one source’s sleep records into nights, and drops scraps', () => {
    const r = (start: number, end: number) => ({ source: 'Watch', start, end, value: 'HKCategoryValueSleepAnalysisAsleepCore', offsetMin: 330 });
    const nights = buildNights([r(0, 3600), r(3600 + 600, 7200), r(7200 + 3 * 3600, 7200 + 5 * 3600), r(90_000, 90_300)]);
    expect(nights.map((n: { start: number; end: number }) => [n.start, n.end])).toEqual([[0, 7200], [18_000, 25_200]]);
  });

  it('thins a GPS track it cannot send whole', () => {
    const pts = Array.from({ length: 4000 }, (_, i) => `<trkpt lon="${77 + i / 1e5}" lat="28.6"><time>${new Date(1_790_000_000_000 + i * 1000).toISOString()}</time></trkpt>`).join('');
    const route = parseGpx(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`);
    expect(route.points).toBe(4000);
    expect(route.t.length).toBeLessThanOrEqual(1501);
    expect(route.t[route.t.length - 1]).toBe(3999);
    expect(route.ele).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Names and units
// ---------------------------------------------------------------------------------------------
describe('metric names, units and device tags', () => {
  it('names what it knows and still makes sense of what it has never seen', () => {
    expect(metricOf('HKQuantityTypeIdentifierHeartRate', 'count/min')).toEqual({ key: 'heart_rate', label: 'Heart rate', unit: 'bpm', agg: 'avg' });
    expect(metricOf('HKQuantityTypeIdentifierDistanceCycling', 'mi')).toMatchObject({ key: 'distance', unit: 'km', agg: 'sum' });
    expect(metricOf('HKQuantityTypeIdentifierUnderwaterDepth', 'm')).toEqual({ key: 'underwater_depth', label: 'Underwater depth', unit: 'm', agg: 'avg' });
    expect(metricOf('HKQuantityTypeIdentifierSwimmingStrokeCount', 'count')).toMatchObject({ key: 'swimming_stroke_count', agg: 'sum', unit: '' });
  });

  it('converts to the stored unit', () => {
    const s = normalizeSeries({
      HKQuantityTypeIdentifierDistanceWalkingRunning: { unit: 'mi', t0: 1000, s: [0], e: [60], v: [1] },
      HKQuantityTypeIdentifierActiveEnergyBurned: { unit: 'kJ', t0: 1000, s: [0], e: [60], v: [418.4] },
      HKQuantityTypeIdentifierRunningSpeed: { unit: 'm/s', t0: 1000, s: [0], e: null, v: [3] },
      HKQuantityTypeIdentifierOxygenSaturation: { unit: '%', t0: 1000, s: [0], e: null, v: [0.97] },
    });
    expect(s.distance).toMatchObject({ unit: 'km', agg: 'sum', v: [1.609], d: [60] });
    expect(s.active_energy!.v).toEqual([100]);
    expect(s.running_speed).toMatchObject({ unit: 'km/h', v: [10.8], d: null });
    expect(s.oxygen_saturation!.v).toEqual([97]);
  });

  it('merges every kind of distance into one series, in time order', () => {
    const s = normalizeSeries({
      HKQuantityTypeIdentifierDistanceCycling: { unit: 'km', t0: 2000, s: [0], e: [10], v: [2] },
      HKQuantityTypeIdentifierDistanceWalkingRunning: { unit: 'km', t0: 1000, s: [0], e: [10], v: [1] },
    });
    expect(s.distance).toMatchObject({ t0: 1000, t: [0, 1000], v: [1, 2] });
  });

  it('labels workout types', () => {
    expect(activityKey('HKWorkoutActivityTypeTraditionalStrengthTraining')).toBe('traditional_strength_training');
    expect(activityLabel('traditional_strength_training')).toBe('Strength training');
    expect(activityLabel(activityKey('HKWorkoutActivityTypeTableTennis'))).toBe('Table tennis');
  });

  it('guesses the brand from the source and its hardware', () => {
    expect(guessTag('Polar Flow')).toBe('polar');
    expect(guessTag('Connect')).toBe('garmin');
    expect(guessTag('LifeOS')).toBe('luna');
    expect(guessTag('Navay’s Apple Watch')).toBe('apple_watch');
    expect(guessTag('Health Sync', { manufacturer: 'Fitbit', name: 'Charge 6' })).toBe('fitbit');
    expect(guessTag('Navay’s iPhone', { name: 'iPhone', hardware: 'iPhone16,2' })).toBe('phone');
    expect(guessTag('Some new app')).toBe('other');
  });
});

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------
const hrSeries = (t0: number, points: [number, number][]): Series => ({ label: 'Heart rate', unit: 'bpm', agg: 'avg', t0, t: points.map((p) => p[0]), d: null, v: points.map((p) => p[1]) });
const T0 = 1_790_000_000;
const everySecond = (n: number, f: (t: number) => number, step = 1): [number, number][] => Array.from({ length: Math.floor(n / step) + 1 }, (_, i) => [i * step, f(i * step)]);

describe('heart rate on its own', () => {
  it('finds a value the device held, gaps, and a late first reading', () => {
    const pts: [number, number][] = [];
    for (let t = 30; t <= 600; t += 2) {
      if (t >= 200 && t < 300) continue; // a dropout
      pts.push([t, t >= 400 && t <= 460 ? 140 : 100 + (t % 7)]);
    }
    const q = heartRateQuality(hrSeries(T0, pts), T0, T0 + 600)!;
    expect(q.interval_s).toBe(2);
    expect(q.first_after_s).toBe(30);
    expect(q.holds).toEqual([{ t0: T0 + 400, t1: T0 + 460, value: 140 }]);
    expect(q.held_s).toBe(60);
    // The 30 s before the first reading, and the dropout.
    expect(q.gaps).toEqual([{ t0: T0, t1: T0 + 30 }, { t0: T0 + 198, t1: T0 + 300 }]);
    expect(q.coverage_pct).toBeGreaterThan(75);
    expect(q.coverage_pct).toBeLessThan(85);
  });

  it('weighs a reading by how long it stood, so a burst of readings does not pull the average', () => {
    // 100 bpm for 100 s read every 10 s, then 160 bpm for 100 s read every second.
    const pts: [number, number][] = [...everySecond(99, () => 100, 10), ...everySecond(100, () => 160).map(([t, v]) => [t + 100, v] as [number, number])];
    const q = heartRateQuality(hrSeries(T0, pts), T0, T0 + 200)!;
    expect(q.mean).toBeGreaterThan(128);
    expect(q.mean).toBeLessThan(132);
    // Half the time below 120, half in 160–179.
    expect(q.zones[0]! + q.zones[1]!).toBeCloseTo(50, 0);
    expect(q.zones[4]).toBeCloseTo(50, 0);
  });

  it('does not call a slowly sampled steady value a held one', () => {
    const q = heartRateQuality(hrSeries(T0, everySecond(3600, () => 55, 300)), T0, T0 + 3600)!;
    expect(q.holds).toEqual([]);
    expect(q.gaps).toEqual([]);
  });
});

describe('heart rate, one device against another', () => {
  const reference = hrSeries(T0, everySecond(1200, (t) => 130 + 25 * Math.sin(t / 90)));

  it('measures the lean, the typical gap and how well the lines move together', () => {
    const test = hrSeries(T0, everySecond(1200, (t) => 126 + 25 * Math.sin(t / 90), 2));
    const a = compareHeartRate(test, reference, T0, T0 + 1200)!;
    expect(a.blocks).toBe(40);
    expect(a.bias).toBeCloseTo(-4, 0);
    expect(a.typical_gap).toBeCloseTo(4, 0);
    expect(a.r).toBeGreaterThan(0.99);
    expect(a.within_5).toBe(100);
    expect(a.verdict).toBe('close');
    expect(a.lag_s).toBeNull();
    expect(a.slow_start).toBe(false);
  });

  it('notices a device that trails the reference', () => {
    const test = hrSeries(T0, everySecond(1200, (t) => 130 + 25 * Math.sin((t - 30) / 90), 2));
    expect(compareHeartRate(test, reference, T0, T0 + 1200)!.lag_s).toBe(30);
  });

  it('reports a slow start apart from the rest', () => {
    const test = hrSeries(T0, everySecond(1200, (t) => 130 + 25 * Math.sin(t / 90) - (t < 180 ? 18 : 1), 2));
    const a = compareHeartRate(test, reference, T0, T0 + 1200)!;
    expect(a.warmup).toMatchObject({ seconds: 180, verdict: 'differs' });
    expect(a.warmup!.bias).toBeCloseTo(-18, 0);
    expect(a.steady).toMatchObject({ verdict: 'match' });
    expect(a.slow_start).toBe(true);
  });

  it('declines to compare recordings that barely overlap', () => {
    expect(compareHeartRate(reference, reference, T0, T0 + 60)).toBeNull();
    expect(compareHeartRate(hrSeries(T0 + 5000, [[0, 100], [1, 100]]), reference, T0, T0 + 1200)).toBeNull();
  });
});

describe('sleep', () => {
  const V = 'HKCategoryValueSleepAnalysis';
  const H = 3600;
  // In bed 23:00, asleep 23:20, 5 min awake at 02:00, up at 06:00, in bed until 06:10.
  const night: [number, number, string][] = [
    [T0, T0 + 7 * H + 600, V + 'InBed'],
    [T0 + 1200, T0 + 2 * H, V + 'AsleepCore'],
    [T0 + 2 * H, T0 + 3 * H, V + 'AsleepDeep'],
    [T0 + 3 * H, T0 + 3 * H + 300, V + 'Awake'],
    [T0 + 3 * H + 300, T0 + 5 * H, V + 'AsleepREM'],
    [T0 + 5 * H, T0 + 7 * H, V + 'AsleepCore'],
  ];

  it('lays overlapping records on one timeline: a stage beats awake beats in bed', () => {
    const stages = buildStages(night, T0, T0 + 7 * H + 600);
    expect(stages.runs.map((r) => r[2])).toEqual(['in_bed', 'core', 'deep', 'awake', 'rem', 'core', 'in_bed']);
    expect(stages.runs[0]).toEqual([0, 1200, 'in_bed']);
  });

  it('works out time asleep, time to fall asleep, time awake and each stage', () => {
    const m = sleepMetrics(buildStages(night, T0, T0 + 7 * H + 600), T0, T0 + 7 * H + 600);
    expect(m.time_in_bed!.value).toBe(7 * H + 600);
    expect(m.sleep_latency!.value).toBe(1200);
    expect(m.waso!.value).toBe(300);
    expect(m.awakenings!.value).toBe(1);
    expect(m.total_sleep!.value).toBe(7 * H - 1200 - 300);
    expect(m.deep_sleep!.value).toBe(H);
    expect(m.rem_sleep!.value).toBe(2 * H - 300);
    expect(m.core_sleep!.value).toBe(2 * H - 1200 + 2 * H);
    expect(m.sleep_efficiency!.value).toBeCloseTo(((7 * H - 1500) / (7 * H + 600)) * 100, 1);
  });

  it('does not invent a time to fall asleep the device never recorded', () => {
    const m = sleepMetrics(buildStages([[T0, T0 + H, V + 'AsleepCore']], T0, T0 + H), T0, T0 + H);
    expect(m.sleep_latency).toBeUndefined();
    expect(m.total_sleep!.value).toBe(H);
  });

  it('has only time in bed for a source that cannot tell sleep from wake', () => {
    const m = sleepMetrics(buildStages([[T0, T0 + 8 * H, V + 'InBed']], T0, T0 + 8 * H), T0, T0 + 8 * H);
    expect(Object.keys(m)).toEqual(['time_in_bed']);
  });

  const rec = (id: string, tag: string, input: IncomingRecording): Rec => {
    const n = normalizeRecording(input, 'sleep', { start: T0, end: T0 + 8 * H });
    return { ...n, id, tag, label: input.source };
  };
  const sleeper = (source: string, segments: [number, number, string][]): IncomingRecording => ({ source, logged: true, samples: {}, sleep: { start: Math.min(...segments.map((s) => s[0])), end: Math.max(...segments.map((s) => s[1])), segments } });

  it('compares two nights epoch by epoch', () => {
    const watch = rec('w', 'apple_watch', sleeper('Watch', night));
    const luna = rec('l', 'luna', sleeper('Luna', [
      [T0 + 1800, T0 + 2 * H, V + 'AsleepCore'],          // falls asleep 10 min later
      [T0 + 2 * H, T0 + 3 * H + 300, V + 'AsleepDeep'],   // sleeps through the 5 min awake
      [T0 + 3 * H + 300, T0 + 5 * H, V + 'AsleepREM'],
      [T0 + 5 * H, T0 + 7 * H, V + 'AsleepCore'],
    ]));
    const a = compareSleep(luna, watch)!;
    expect(a.labels).toEqual(['Awake', 'Light', 'Deep', 'REM']);
    // 10 min called awake that the watch has as sleep; 5 min of the watch's awake missed.
    expect(a.sensitivity).toBeCloseTo(((7 * H - 1500 - 600) / (7 * H - 1500)) * 100, 0);
    expect(a.specificity).toBeLessThan(100);
    expect(a.sleep_wake_pct).toBeGreaterThan(95);
    expect(a.stage_pct).toBeGreaterThan(95);
    expect(a.kappa).toBeGreaterThan(0.9);
    expect(a.confusion![0]![2]).toBe(10); // the watch's 5 awake minutes, as 30-second epochs Luna calls deep

    const s = analyzeSession([watch, luna], 'sleep').summary;
    expect(s.primary).toBe(0);
    expect(s.pairs[0]).toMatchObject({ test: 'l', reference: 'w' });
    // Luna recorded no wait for sleep, so there is nothing to set against the watch's 20 minutes.
    expect(s.pairs[0]!.rows.find((r) => r.key === 'sleep_latency')).toMatchObject({ reference: 1200, test: null, verdict: 'only_reference' });
    expect(s.pairs[0]!.rows.find((r) => r.key === 'total_sleep')).toMatchObject({ diff: -300, verdict: 'match' });
    expect(s.headline.sleep).toMatchObject({ sleep_wake_pct: a.sleep_wake_pct });
  });

  it('cannot compare against a source that only knows "in bed"', () => {
    const phone = rec('p', 'phone', sleeper('iPhone', [[T0, T0 + 8 * H, V + 'InBed']]));
    const luna = rec('l', 'luna', sleeper('Luna', night));
    expect(compareSleep(luna, phone)).toBeNull();
  });
});

describe('a whole workout session', () => {
  const window = { start: T0, end: T0 + 1200 };
  const hr = (f: (t: number) => number, step: number, from = 0) => {
    const pts = everySecond(1200 - from, (t) => Math.round(f(t + from)), step);
    return { unit: 'count/min', t0: T0 + from, s: pts.map((p) => p[0]), e: null, v: pts.map((p) => p[1]) };
  };
  const workout = (start: number, end: number, km: number, kcal: number) => ({
    activity: 'HKWorkoutActivityTypeRunning', start, end, duration: (end - start) / 60, duration_unit: 'min',
    stats: [{ type: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal', sum: kcal }, { type: 'HKQuantityTypeIdentifierDistanceWalkingRunning', unit: 'km', sum: km }],
    metadata: {}, events: [],
  });
  const make = (id: string, tag: string, input: IncomingRecording): Rec => ({ ...normalizeRecording(input, 'workout', window), id, tag, label: input.source });
  const polar = make('p', 'polar', { source: 'Polar Flow', logged: true, samples: { HKQuantityTypeIdentifierHeartRate: hr((t) => 150 + 20 * Math.sin(t / 120), 1) }, workout: workout(T0, T0 + 1200, 3.0, 300), profile: { weight_kg: 80 } });
  const luna = make('l', 'luna', { source: 'Luna', logged: true, samples: { HKQuantityTypeIdentifierHeartRate: hr((t) => 148 + 20 * Math.sin(t / 120) + (t % 3) - 1, 2, 10) }, workout: workout(T0 + 10, T0 + 1190, 2.97, 110), profile: { weight_kg: 46 } });
  const phone = make('i', 'phone', { source: 'iPhone', logged: false, samples: { HKQuantityTypeIdentifierStepCount: { unit: 'count', t0: T0 - 600, s: [0], e: [1200], v: [1000] } } });

  it('tests Luna against the reference, and leaves the phone in the background', () => {
    const a = analyzeSession([phone, polar, luna], 'workout');
    expect(a.window).toEqual(window);
    expect(a.activity).toBe('running');
    expect(a.summary.recordings.map((r) => r.id)).toEqual(['l', 'p', 'i']);
    expect(a.summary.pairs).toHaveLength(1);
    const pair = a.summary.pairs[0]!;
    expect(pair).toMatchObject({ test: 'l', reference: 'p' });
    expect(pair.hr).toMatchObject({ verdict: 'match' });
    expect(pair.hr!.bias).toBeCloseTo(-2, 0);
    const row = (key: string) => pair.rows.find((r) => r.key === key)!;
    expect(row('start')).toMatchObject({ unit: 'clock', diff: 10, verdict: 'match' });
    expect(row('distance')).toMatchObject({ reference: 3, test: 2.97, pct: -1, verdict: 'match' });
    expect(row('pace')).toMatchObject({ unit: 's/km', verdict: 'match' });
    // 46 kg against 80 kg: the calories cannot agree, so they are not judged.
    expect(row('active_energy')).toMatchObject({ verdict: 'not_comparable' });
    expect(a.summary.findings.map((f) => f.title)).toEqual(['Heart rate tracks the reference', 'Calories are not comparable']);
    expect(a.summary.headline).toMatchObject({ test: 'luna', reference: 'polar', hr: { verdict: 'match' } });
    // The phone's steps: the half of its 20-minute record that falls inside the session.
    expect(a.metrics.get('i')!.steps).toMatchObject({ value: 500, from: 'samples' });
  });

  it('takes totals from the device’s own summary and heart rate from its samples', () => {
    const m = analyzeSession([polar], 'workout').metrics.get('p')!;
    expect(m.duration).toMatchObject({ value: 1200, from: 'summary' });
    expect(m.distance).toMatchObject({ value: 3, from: 'summary' });
    expect(m.heart_rate).toMatchObject({ from: 'samples', n: 1201 });
    expect(m.pace).toMatchObject({ value: 400, from: 'derived' });
    expect(m.speed).toMatchObject({ value: 9 });
  });

  it('with no Luna, measures the others against the best reference', () => {
    const garmin = make('g', 'garmin', { source: 'Connect', logged: true, samples: {}, workout: workout(T0, T0 + 1200, 3.1, 290) });
    const s = analyzeSession([garmin, polar, phone], 'workout').summary;
    expect(s.pairs.map((p) => [p.test, p.reference])).toEqual([['g', 'p']]);
    expect(s.headline).toMatchObject({ test: 'garmin', reference: 'polar', hr: null });
  });

  it('has nothing to compare for one device and a phone', () => {
    const s = analyzeSession([polar, phone], 'workout').summary;
    expect(s.pairs).toEqual([]);
    expect(s.primary).toBeNull();
    expect(s.findings).toEqual([]);
  });
});

describe('which workouts in an export are one session', () => {
  const c = (key: string, source: string, start: number, end: number) => ({ key, kind: 'workout' as const, source, start, end });

  it('joins overlapping workouts from different devices, never two from the same one', () => {
    const groups = groupCandidates([
      c('p1', 'Polar', 0, 1500), c('p2', 'Polar', 2400, 3800), c('l1', 'Luna', -30, 3800), c('g1', 'Garmin', 2380, 3790), c('p3', 'Polar', 9000, 9600),
      { key: 's1', kind: 'sleep', source: 'Luna', start: 0, end: 1500 },
    ]);
    // Luna logged one long workout over both of Polar's. Garmin logged the second, almost to the
    // second with Polar, so those two pair up and Luna stays with the first.
    expect(groups.map((g) => [g.kind, g.members.map((m) => m.key).sort()])).toEqual([
      ['workout', ['l1', 'p1']],
      ['sleep', ['s1']],
      ['workout', ['g1', 'p2']],
      ['workout', ['p3']],
    ]);
    expect(groups[0]).toMatchObject({ start: -30, end: 3800 });
  });

  it('keeps workouts that only touch apart', () => {
    expect(groupCandidates([c('a', 'Polar', 0, 1000), c('b', 'Luna', 900, 2000)])).toHaveLength(2);
  });
});
