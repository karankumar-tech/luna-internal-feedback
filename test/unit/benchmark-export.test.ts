import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { excelDuration, excelTime, workbook } from '../../src/lib/xlsx.js';
import { analyzeSession, normalizeRecording, type IncomingRecording, type Kind, type Rec } from '../../src/modules/benchmarks/analyze.js';
import { listWorkbook, sessionWorkbook } from '../../src/modules/benchmarks/export.js';
import type { RecordingRow, SessionRow } from '../../src/modules/benchmarks/benchmarks.repo.js';

// ---------------------------------------------------------------------------------------------
// Reading a workbook back: sheet names, and each sheet's cells with the number format they show in.
// ---------------------------------------------------------------------------------------------
type Read = { v: string | number | boolean | null; fmt: string };
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function readBook(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const text = (p: string) => strFromU8(files[p]!);
  const names = [...text('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map((m) => unxml(m[1]!));
  const styles = text('xl/styles.xml');
  const formats = new Map([...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)].map((m) => [m[1]!, unxml(m[2]!)]));
  const xfs = [...styles.match(/<cellXfs[^>]*>(.*)<\/cellXfs>/)![1]!.matchAll(/<xf numFmtId="(\d+)"/g)].map((m) => formats.get(m[1]!) ?? 'General');
  const sheets = new Map<string, { xml: string; rows: Read[][] }>();
  names.forEach((name, i) => {
    const xml = text(`xl/worksheets/sheet${i + 1}.xml`);
    const rows: Read[][] = [];
    for (const row of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
      const cells: Read[] = [];
      for (const c of row[2]!.matchAll(/<c r="([A-Z]+)\d+"(?: s="(\d+)")?(?: t="(\w+)")?(?:\/>|>(.*?)<\/c>)/g)) {
        const fmt = xfs[Number(c[2] ?? 0)]!;
        const body = c[4] ?? '';
        const v = c[3] === 'inlineStr' ? unxml(/<t[^>]*>(.*)<\/t>/s.exec(body)![1]!) : c[3] === 'b' ? body.includes('>1<') : /<v>(.*)<\/v>/.exec(body) ? Number(/<v>(.*)<\/v>/.exec(body)![1]) : null;
        cells[colIndex(c[1]!)] = { v, fmt };
      }
      rows[Number(row[1]) - 1] = cells;
    }
    sheets.set(name, { xml, rows });
  });
  return { files, names, sheets, values: (name: string) => sheets.get(name)!.rows.map((r) => (r ?? []).map((c) => c?.v ?? null)) };
}

// ---------------------------------------------------------------------------------------------
// A session built the way an import builds one: Polar and Luna on a 20-minute run, the phone
// counting steps; and a night on Luna and Garmin.
// ---------------------------------------------------------------------------------------------
const T = Date.UTC(2026, 8, 30, 4, 30) / 1000; // 30 Sep 2026, 10:00 IST
const heartRate = (start: number, seconds: number, step: number, f: (t: number) => number) => {
  const s: number[] = [], v: number[] = [];
  for (let t = 0; t <= seconds; t += step) { s.push(t); v.push(Math.round(f(t))); }
  return { unit: 'count/min', t0: start, s, e: null, v };
};
const run = (start: number, end: number, km: number, kcal: number) => ({
  activity: 'HKWorkoutActivityTypeRunning', start, end, duration: (end - start) / 60, duration_unit: 'min',
  stats: [{ type: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal', sum: kcal }, { type: 'HKQuantityTypeIdentifierDistanceWalkingRunning', unit: 'km', sum: km }],
  metadata: {}, events: [],
});

function build(kind: Kind, incoming: (IncomingRecording & { tag: string })[], over: Partial<SessionRow> = {}): { session: SessionRow; recordings: RecordingRow[] } {
  const window = { start: Math.min(...incoming.map((r) => r.workout?.start ?? r.sleep?.start ?? Infinity)), end: Math.max(...incoming.map((r) => r.workout?.end ?? r.sleep?.end ?? -Infinity)) };
  const recs: Rec[] = incoming.map((r, i) => ({ ...normalizeRecording(r, kind, window), id: `rec-${i}`, tag: r.tag, label: r.source }));
  const a = analyzeSession(recs, kind);
  const session: SessionRow = {
    id: 'session-1', ref: 'BM-0042', kind, activity: a.activity, title: null, tester: 'Asha', started_at: a.window.start, ended_at: a.window.end, utc_offset_min: 330,
    devices: [...new Set(recs.map((r) => r.tag))], summary: a.summary, notes: 'Polar strap on the chest, Luna on the left wrist.', screenshots: [], is_test: false,
    uploaded_by: 'qc@luna.invalid', created_at: new Date('2026-10-01T06:00:00Z'), updated_at: new Date('2026-10-01T06:00:00Z'), ...over,
  };
  const recordings: RecordingRow[] = recs.map((r) => ({
    id: r.id, session_id: session.id, source_name: r.source, source_version: null, device_tag: r.tag, device_label: null, logged: r.logged, fingerprint: null, activity: r.activity,
    started_at: r.start, ended_at: r.end, metrics: a.metrics.get(r.id)!, series: r.series, stages: r.stages, route: r.route, details: { ...r.details, hr: a.hr.get(r.id) ?? null },
  }));
  return { session, recordings };
}

const workoutSession = () => build('workout', [
  // Luna first, as the session page orders them: the device under test, then the reference.
  { tag: 'luna', source: 'Luna', logged: true, workout: run(T + 10, T + 1190, 2.97, 110), samples: { HKQuantityTypeIdentifierHeartRate: heartRate(T + 10, 1180, 2, (x) => (x >= 400 && x < 470 ? 131 : 147 + 20 * Math.sin((x + 10) / 120))) } },
  { tag: 'polar', source: 'Polar Flow', logged: true, workout: run(T, T + 1200, 3.0, 300), samples: { HKQuantityTypeIdentifierHeartRate: heartRate(T, 1200, 1, (x) => 150 + 20 * Math.sin(x / 120)) } },
  { tag: 'phone', source: 'iPhone', logged: false, samples: { HKQuantityTypeIdentifierStepCount: { unit: 'count', t0: T, s: [0, 600], e: [600, 1200], v: [900, 950] } } },
]);

const NIGHT = Date.UTC(2026, 8, 30, 18, 0) / 1000; // 30 Sep 2026, 23:30 IST
const nightSession = () => build('sleep', [
  { tag: 'luna', source: 'Luna', logged: true, samples: {}, sleep: { start: NIGHT, end: NIGHT + 7 * 3600, segments: [
    [NIGHT, NIGHT + 1800, 'HKCategoryValueSleepAnalysisAwake'], [NIGHT + 1800, NIGHT + 3 * 3600, 'HKCategoryValueSleepAnalysisAsleepCore'],
    [NIGHT + 3 * 3600, NIGHT + 4 * 3600, 'HKCategoryValueSleepAnalysisAsleepDeep'], [NIGHT + 4 * 3600, NIGHT + 7 * 3600, 'HKCategoryValueSleepAnalysisAsleepREM'],
  ] } },
  { tag: 'garmin', source: 'Connect', logged: true, samples: {}, sleep: { start: NIGHT - 600, end: NIGHT + 7 * 3600, segments: [
    [NIGHT - 600, NIGHT + 1200, 'HKCategoryValueSleepAnalysisAwake'], [NIGHT + 1200, NIGHT + 3 * 3600, 'HKCategoryValueSleepAnalysisAsleepCore'],
    [NIGHT + 3 * 3600, NIGHT + 5 * 3600, 'HKCategoryValueSleepAnalysisAsleepDeep'], [NIGHT + 5 * 3600, NIGHT + 7 * 3600, 'HKCategoryValueSleepAnalysisAsleepREM'],
  ] } },
], { ref: 'BM-0043', notes: null });

const OPTS = { baseUrl: 'https://luna.example.test/', timeZone: 'Asia/Kolkata', now: new Date('2026-10-08T05:00:00Z') };

describe('the Excel writer', () => {
  it('writes a workbook with safe sheet names, escaped text, numbers in their formats, and a frozen, filterable header', () => {
    const book = readBook(workbook([
      { name: 'Heart/rate: raw?', header: ['Name', 'Value'], rows: [['<b> & "quoted"', { v: 142.5, fmt: '0.0" bpm"' }], [' leading space', null], [true, Number.NaN]] },
      { name: 'Heart rate  raw', rows: [['second']] },
    ]));
    expect(Object.keys(book.files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    // Excel refuses [ ] : * ? / \ in a sheet name, and two sheets of one name.
    expect(book.names).toEqual(['Heart rate  raw', 'Heart rate  raw 2']);
    const first = book.sheets.get('Heart rate  raw')!;
    expect(first.rows[0]!.map((c) => [c.v, c.fmt])).toEqual([['Name', 'General'], ['Value', 'General']]);
    expect(first.rows[1]).toEqual([{ v: '<b> & "quoted"', fmt: 'General' }, { v: 142.5, fmt: '0.0" bpm"' }]);
    expect(first.rows[2]![0]).toEqual({ v: ' leading space', fmt: 'General' });
    expect(first.rows[3]).toEqual([{ v: true, fmt: 'General' }]);
    expect(first.xml).toContain('state="frozen"');
    expect(first.xml).toContain('<autoFilter ref="A1:B4"/>');
    expect(strFromU8(book.files['xl/workbook.xml']!)).toContain(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Heart rate  raw'!$A$1:$B$4</definedName>`);
    // The header is bold; a sheet with no header has neither a frozen row nor a filter.
    expect(book.sheets.get('Heart rate  raw 2')!.xml).not.toContain('autoFilter');
  });

  it('turns moments into Excel dates on the wearer’s clock, and lengths into fractions of a day', () => {
    expect(excelTime(0)).toBe(25569);
    const tenTwoIst = Date.UTC(2026, 8, 30, 4, 32) / 1000;
    expect(excelTime(tenTwoIst, 330)).toBeCloseTo((Date.UTC(2026, 8, 30, 10, 2) - Date.UTC(1899, 11, 30)) / 86_400_000, 9);
    expect(excelDuration(1800)).toBeCloseTo(1 / 48, 12);
  });
});

describe('one session as a workbook', () => {
  it('leads with a summary that says what the session is and what each sheet holds', () => {
    const { session, recordings } = workoutSession();
    const file = sessionWorkbook(session, recordings, OPTS);
    expect(file.filename).toBe('luna-benchmark-BM-0042-2026-09-30.xlsx');
    const book = readBook(file.body);
    expect(book.names).toEqual(['Summary', 'Comparison', 'Agreement', 'Measures', 'Devices', 'Heart rate', 'Heart rate readings', 'Heart rate issues', 'Heart rate ranges', 'Other readings']);
    // The first value under each label: the sheet list at the end repeats some labels.
    const summary = new Map(book.values('Summary').filter((r) => r.length >= 2).reverse().map((r) => [r[0], r[1]]));
    expect(book.values('Summary')[0]).toEqual(['Luna benchmark BM-0042']);
    expect(summary.get('Link')).toBe('https://luna.example.test/b/BM-0042');
    expect(summary.get('What')).toBe('Running');
    expect(summary.get('Started')).toBeCloseTo(excelTime(T, 330), 9);
    expect(summary.get('Times are')).toBe('The wearer’s clock, UTC+05:30');
    expect(summary.get('Devices')).toBe('Luna (under test), Polar Flow (reference), iPhone (background)');
    expect(summary.get('Compared')).toBe('Luna against Polar Flow');
    expect(summary.get('Heart rate, verdict')).toMatch(/^(Match|Close|Differs)$/);
    expect(summary.get('Notes')).toBe('Polar strap on the chest, Luna on the left wrist.');
    expect(summary.get('Exported')).toBe('2026-10-08 10:30:00 +05:30');
    for (const name of book.names.slice(1)) expect(summary.has(name)).toBe(true);
  });

  it('puts every side-by-side number in its unit, with the difference and the verdict', () => {
    const { session, recordings } = workoutSession();
    const book = readBook(sessionWorkbook(session, recordings, OPTS).body);
    const rows = book.sheets.get('Comparison')!.rows;
    expect(rows[0]!.map((c) => c.v)).toEqual(['Under test', 'Reference', 'Measure', 'Reference value', 'Under test value', 'Difference', 'Difference %', 'Verdict', 'Note']);
    const row = (label: string) => rows.find((r) => r[2]?.v === label)!;
    expect(row('Distance').slice(3, 8).map((c) => c?.v ?? null)).toEqual([3, 2.97, -0.03, -0.01, 'Match']);
    // A percentage is a fraction shown with %, as Excel keeps one; a % inside a quoted unit is read as a percent by some viewers.
    expect(row('Distance')[6]!.fmt).toBe('+0.0%;-0.0%;0.0%');
    expect(row('Distance')[3]!.fmt).toBe('#,##0.00" km"');
    expect(row('Distance')[5]!.fmt).toBe('+#,##0.00" km";-#,##0.00" km";#,##0.00" km"');
    // A moment shows as a clock time on the wearer's clock; its difference in seconds.
    expect(row('Start')[3]).toEqual({ v: excelTime(T, 330), fmt: 'hh:mm:ss' });
    expect(row('Start')[5]).toEqual({ v: 10, fmt: '+#,##0" s";-#,##0" s";#,##0" s"' });
    expect(row('Duration')[4]).toEqual({ v: excelDuration(1180), fmt: '[h]:mm:ss' });
    expect(row('Average pace (per km)')[3]).toEqual({ v: excelDuration(400), fmt: '[m]:ss' });
    // The two apps have no body weight here, so calories are compared and differ.
    expect(row('Active calories')[7]!.v).toBe('Differs');
  });

  it('explains the heart rate agreement, and lists every device with its role', () => {
    const { session, recordings } = workoutSession();
    const book = readBook(sessionWorkbook(session, recordings, OPTS).body);
    const agreement = book.values('Agreement');
    expect(agreement.find((r) => r[2] === 'Typical gap')!.slice(0, 2)).toEqual(['Luna', 'Polar Flow']);
    expect(agreement.find((r) => r[2] === 'Lean')![3]).toBeLessThan(0);
    const devices = book.values('Devices');
    expect(devices.slice(1).map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      ['Luna', 'Luna', 'Under test', 'Yes'], ['Polar Flow', 'Polar', 'Reference', 'Yes'], ['iPhone', 'Phone', 'Background', 'No, readings only'],
    ]);
    // Luna held 131 bpm for over a minute: the stretch is listed with its value.
    const held = book.values('Heart rate issues').filter((r) => r[1] === 'Same value held');
    expect(held.find((r) => r[5] === 131)![0]).toBe('Luna');
  });

  it('gives heart rate on one clock as the page averages it, and every reading as written', () => {
    const { session, recordings } = workoutSession();
    const book = readBook(sessionWorkbook(session, recordings, OPTS).body);
    const hr = book.sheets.get('Heart rate')!.rows;
    expect(hr[0]!.map((c) => c.v)).toEqual(['Time', 'Since the start', 'Luna (bpm)', 'Polar Flow (bpm)', 'Luna minus Polar Flow (bpm)']);
    // Five-second averages for a 20-minute run, on round clock times: [10:00:00, 10:20:00).
    expect(hr.length - 1).toBe(240);
    expect(hr[1]![0]!.v).toBeCloseTo(excelTime(T, 330), 9);
    expect(hr[2]![0]!.v as number - (hr[1]![0]!.v as number)).toBeCloseTo(5 / 86400, 9);
    expect(hr[1]![2]!.v).toBeNull(); // Luna had not started yet
    const readings = book.values('Heart rate readings');
    expect(readings.length - 1).toBe(recordings[0]!.series.heart_rate!.v.length + recordings[1]!.series.heart_rate!.v.length);
    expect(readings.filter((r) => r[2] === 'Polar Flow')).toHaveLength(1201);
    expect(book.values('Other readings').slice(1)).toEqual([
      ['iPhone', 'Steps', excelTime(T, 330), excelTime(T + 600, 330), 0, 900, ''],
      ['iPhone', 'Steps', excelTime(T + 600, 330), excelTime(T + 1200, 330), excelDuration(600), 950, ''],
    ]);
  });

  it('gives a night its stages, the stage table and the agreement, in hours and minutes', () => {
    const { session, recordings } = nightSession();
    const book = readBook(sessionWorkbook(session, recordings, OPTS).body);
    expect(book.names).toEqual(['Summary', 'Comparison', 'Agreement', 'Stage table', 'Measures', 'Devices', 'Sleep stages']);
    const stages = book.values('Sleep stages');
    expect(stages[0]).toEqual(['Device', 'Stage', 'From', 'To', 'Length']);
    expect(stages.filter((r) => r[0] === 'Luna').map((r) => r[1])).toEqual(['Awake', 'Light (core)', 'Deep', 'REM']);
    const asleep = book.sheets.get('Comparison')!.rows.find((r) => r[2]?.v === 'Time asleep')!;
    expect(asleep[4]!.fmt).toBe('[h]:mm');
    expect(asleep[5]).toEqual({ v: -10, fmt: '+#,##0" min";-#,##0" min";#,##0" min"' });
    const table = book.values('Stage table');
    expect(table[1]).toEqual(['Connect ↓  Luna →', 'Awake', 'Light', 'Deep', 'REM']);
    // Luna's deep hour falls inside Garmin's two deep hours.
    expect(table[4]![3]).toBe(60);
    expect(book.values('Agreement').find((r) => r[2] === 'Same stage')![3]).toBeGreaterThan(0.5);
  });
});

describe('a list of sessions as a workbook', () => {
  it('has a line per session, every comparison, the agreement and findings, and the filters used', () => {
    const a = workoutSession().session, b = nightSession().session;
    const file = listWorkbook([b, a], { ...OPTS, filters: [['Data', 'Real only']] });
    expect(file.filename).toBe('luna-benchmarks-2026-10-08.xlsx');
    const book = readBook(file.body);
    expect(book.names).toEqual(['Sessions', 'Comparison', 'Agreement', 'Findings', 'About']);
    const sessions = book.values('Sessions');
    expect(sessions.slice(1).map((r) => [r[0], r[4], r[5], r[8], r[9], r[10], r[11]])).toEqual([
      ['BM-0043', 'Sleep', 'Sleep', 'Luna, Connect', '', 'Luna', 'Connect'],
      ['BM-0042', 'Workout', 'Running', 'Luna, Polar Flow', 'iPhone', 'Luna', 'Polar Flow'],
    ]);
    expect(sessions[2]![21]).toBe('https://luna.example.test/b/BM-0042');
    const comparison = book.values('Comparison');
    expect(new Set(comparison.slice(1).map((r) => r[0]))).toEqual(new Set(['BM-0042', 'BM-0043']));
    expect(comparison.find((r) => r[0] === 'BM-0042' && r[6] === 'Distance')!.slice(7, 12)).toEqual([3, 2.97, -0.03, -0.01, 'Match']);
    expect(book.values('Agreement').slice(1).map((r) => r[0])).toEqual(['BM-0043', 'BM-0042']);
    expect(book.values('Findings').length).toBeGreaterThan(1);
    const about = new Map(book.values('About').filter((r) => r.length >= 2).map((r) => [r[0], r[1]]));
    expect(about.get('Number of sessions')).toBe(2);
    expect(about.get('Filters')).toBe('Data: Real only');
  });
});
