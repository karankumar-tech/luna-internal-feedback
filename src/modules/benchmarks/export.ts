/**
 * Benchmark data as Excel workbooks a person can read: one session in full, or a list of sessions
 * with their comparisons. Times are the wearer's own clock time, as on the dashboard. Units sit in
 * the number formats ("142.0 bpm" is the number 142 shown with its unit), so the numbers can still
 * be sorted, filtered and summed.
 */
import { formatInZone, todayInZone } from '../../lib/time.js';
import { excelDuration, excelTime, fmtText, workbook, type Cell, type CellInput, type Sheet } from '../../lib/xlsx.js';
import { bucketMeans, ZONE_LABELS, type HrAgreement, type Kind, type MetricValue, type Pair, type Row, type SleepAgreement, type Stage, type Summary, type Verdict } from './analyze.js';
import { activityLabel, tagLabel } from './metrics.js';
import type { RecordingRow, SessionRow } from './benchmarks.repo.js';

export interface ExportFile { filename: string; body: Uint8Array }
export interface ExportOptions { baseUrl: string; timeZone: string; now?: Date }

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DATE_TIME = 'd mmm yyyy hh:mm:ss';

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

/** Digits after the point, by unit; anything not listed gets one. */
const DIGITS: Record<string, number> = { '': 0, kcal: 0, km: 2, 'steps/min': 0 };

/** "#,##0.0 bpm"; signed: "+3.0 bpm", "-3.0 bpm". Not for percentages or times: some viewers misread those with text added. */
function numberFormat(unit: string, signed = false, digits = DIGITS[unit] ?? 1): string {
  const n = digits ? `#,##0.${'0'.repeat(digits)}` : '#,##0';
  const u = unit === '' ? '' : fmtText(` ${unit}`);
  return signed ? `+${n}${u};-${n}${u};${n}${u}` : `${n}${u}`;
}

/** A percentage as Excel keeps one, a fraction shown with %: every viewer reads it the same way. */
const pctCell = (v: number | null | undefined, signed = false): Cell => ({ v: v == null ? null : v / 100, fmt: signed ? '+0.0%;-0.0%;0.0%' : '0.0%' });
/** Pace shows as minutes and seconds; the label says per what. */
const measureLabel = (label: string, unit: string) => (unit === 's/km' ? `${label} (per km)` : label);
const bpmCell = (v: number | null | undefined, signed = false): Cell => ({ v: v ?? null, fmt: numberFormat('bpm', signed) });
const yes = (b: boolean) => (b ? 'Yes' : 'No');

/** One session's way of writing times and lengths. */
class Clock {
  constructor(readonly kind: Kind, readonly offsetMin: number, readonly start: number) {}

  at(seconds: number | null | undefined, fmt = DATE_TIME): Cell { return { v: seconds == null ? null : excelTime(seconds, this.offsetMin), fmt }; }
  /** A night is read in minutes, a workout to the second. */
  length(seconds: number | null | undefined): Cell { return { v: seconds == null ? null : excelDuration(seconds), fmt: this.kind === 'sleep' ? '[h]:mm' : '[h]:mm:ss' }; }
  /** Time since the session started; blank before it, where a length cannot be negative. */
  since(seconds: number): Cell { return seconds < this.start ? { v: null } : { v: excelDuration(seconds - this.start), fmt: '[h]:mm:ss' }; }

  /** A reported number in its unit. */
  value(v: number | null | undefined, unit: string): Cell {
    if (v === null || v === undefined) return { v: null };
    if (unit === 's') return this.length(v);
    if (unit === 'clock') return this.at(v, this.kind === 'sleep' ? 'd mmm hh:mm' : 'hh:mm:ss');
    if (unit === 's/km') return { v: excelDuration(v), fmt: '[m]:ss' };
    if (unit === '%') return pctCell(v);
    return { v, fmt: numberFormat(unit) };
  }

  /** Under test minus reference. Lengths and moments in minutes for a night, in seconds for a workout. */
  difference(d: number | null, unit: string): Cell {
    if (d === null) return { v: null };
    if (unit === 's' || unit === 'clock') return this.kind === 'sleep' ? { v: d / 60, fmt: numberFormat('min', true, 0) } : { v: d, fmt: numberFormat('s', true, 0) };
    if (unit === 's/km') return { v: d, fmt: numberFormat('s/km', true, 0) };
    if (unit === '%') return { v: d, fmt: numberFormat('points', true, 1) };
    return { v: d, fmt: numberFormat(unit, true) };
  }
}

const clockOf = (s: SessionRow) => new Clock(s.kind, s.utc_offset_min, s.started_at);

const VERDICT: Record<Verdict, string> = { match: 'Match', close: 'Close', differs: 'Differs', not_comparable: 'Not comparable', only_test: 'Under test only', only_reference: 'Reference only' };
const verdictText = (v: Verdict, test: string, reference: string) => (v === 'only_test' ? `${test} only` : v === 'only_reference' ? `${reference} only` : VERDICT[v]);

const STAGE_LABEL: Record<Stage, string> = { awake: 'Awake', rem: 'REM', core: 'Light (core)', deep: 'Deep', asleep: 'Asleep, no stage given', in_bed: 'In bed' };
const METRIC_ORDER = ['duration', 'time_in_bed', 'total_sleep', 'sleep_latency', 'waso', 'awakenings', 'sleep_efficiency', 'deep_sleep', 'core_sleep', 'rem_sleep', 'unstaged_sleep', 'distance', 'pace', 'max_pace', 'speed', 'active_energy', 'basal_energy', 'steps', 'cadence', 'heart_rate', 'vo2_max'];
const metricRank = (key: string) => { const i = METRIC_ORDER.indexOf(key); return i === -1 ? METRIC_ORDER.length : i; };
const metricLabel = (key: string, m: { label: string }) => (key === 'heart_rate' ? 'Average heart rate' : m.label);

const whatOf = (s: { kind: Kind; activity: string | null }) => (s.kind === 'sleep' ? 'Sleep' : activityLabel(s.activity));
const linkOf = (baseUrl: string, ref: string) => `${baseUrl.replace(/\/+$/, '')}/b/${encodeURIComponent(ref)}`;
const offsetLabel = (min: number) => `UTC${min < 0 ? '−' : '+'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}:${String(Math.abs(min) % 60).padStart(2, '0')}`;
/** The session's own day, as a file name part: 2026-09-30. */
const dayOf = (s: SessionRow) => new Date((s.started_at + s.utc_offset_min * 60) * 1000).toISOString().slice(0, 10);
const summaryOf = (s: SessionRow): Summary | null => ((s.summary as Summary).version ? (s.summary as Summary) : null);
const PLATFORM: Record<string, string> = { ios: 'iOS', android: 'Android' };

/** The averaging step the session page draws heart rate with: 5 s up to half an hour, 10 s up to three hours. */
const stepFor = (seconds: number) => (seconds <= 1800 ? 5 : seconds <= 3 * 3600 ? 10 : seconds <= 8 * 3600 ? 30 : 60);

/** Each pair's under-test and reference device by name. */
function pairNames(summary: Summary | null, p: Pair): [string, string] {
  const name = (id: string) => summary?.recordings.find((r) => r.id === id)?.label ?? 'Unknown device';
  return [name(p.test), name(p.reference)];
}

// ---------------------------------------------------------------------------------------------
// Rows shared by both workbooks
// ---------------------------------------------------------------------------------------------

/** One comparison row: reference, under test, difference, verdict. */
function comparisonCells(c: Clock, row: Row, test: string, reference: string): CellInput[] {
  return [measureLabel(row.label, row.unit), c.value(row.reference, row.unit), c.value(row.test, row.unit), c.difference(row.diff, row.unit), pctCell(row.pct, true), verdictText(row.verdict, test, reference), row.note ?? ''];
}

/** Heart rate agreement, one line per number, with what it means. */
function hrAgreementRows(c: Clock, a: HrAgreement, test: string, reference: string): [string, CellInput, string][] {
  const out: [string, CellInput, string][] = [
    ['Time both were recording', c.length(a.overlap_s), ''],
    ['Half-minutes compared', a.blocks, 'Each half-minute, the two devices’ average heart rates are set side by side.'],
    ['Typical gap', bpmCell(a.typical_gap), 'The average gap between the two, half-minute by half-minute, whichever reads higher.'],
    ['Gap on the middle half-minute', bpmCell(a.median_gap), 'Half of the half-minutes are closer than this. Less moved by one bad stretch than the typical gap.'],
    ['Lean', bpmCell(a.bias, true), `${test} minus ${reference} on average: below zero reads low, above reads high.`],
    ['Root mean square gap', bpmCell(a.rmse), 'Like the typical gap, with big gaps counting for more.'],
    ['Correlation', { v: a.r, fmt: '0.00' }, '1: the two rise and fall together. 0: no relation.'],
    ['Within 5 bpm', pctCell(a.within_5), 'Share of the half-minutes.'],
    ['Within 10 bpm', pctCell(a.within_10), 'Share of the half-minutes.'],
    ['Widest gap', bpmCell(a.max_gap, true), `${test} minus ${reference}.`],
    ['Widest gap at', c.at(a.max_gap_at, 'hh:mm:ss'), ''],
    ['95% of gaps from', bpmCell(a.loa_low, true), 'Limits of agreement: 95 of every 100 half-minutes fall between these two.'],
    ['95% of gaps to', bpmCell(a.loa_high, true), ''],
  ];
  if (a.warmup) out.push(
    ['First 3 minutes: lean', bpmCell(a.warmup.bias, true), ''],
    ['First 3 minutes: typical gap', bpmCell(a.warmup.typical_gap), ''],
    ['First 3 minutes: verdict', VERDICT[a.warmup.verdict], ''],
  );
  if (a.steady) out.push(
    ['After the first 3 minutes: lean', bpmCell(a.steady.bias, true), ''],
    ['After the first 3 minutes: typical gap', bpmCell(a.steady.typical_gap), ''],
    ['After the first 3 minutes: verdict', VERDICT[a.steady.verdict], ''],
  );
  out.push(['Slow to lock on at the start', yes(a.slow_start), 'The first 3 minutes are far worse than the rest.']);
  if (a.lag_s !== null) out.push(['Trails the reference by', { v: a.lag_s, fmt: numberFormat('s', true, 0) }, `Moving ${test} this much earlier matches ${reference} best. Below zero: it leads.`]);
  out.push(['Verdict', VERDICT[a.verdict], 'Match: a typical gap of 3 bpm or less. Close: 7 or less. Otherwise differs.']);
  return out;
}

function sleepAgreementRows(c: Clock, a: SleepAgreement, test: string, reference: string): [string, CellInput, string][] {
  return [
    ['Night compared', c.length(a.epochs * 30), 'In 30-second steps, over the whole night either device recorded.'],
    ['Asleep or awake: the same', pctCell(a.sleep_wake_pct), 'Share of the night both call asleep, or both call awake.'],
    [`${reference}’s sleep that ${test} also has as sleep`, pctCell(a.sensitivity), ''],
    [`${reference}’s awake time that ${test} also has as awake`, pctCell(a.specificity), ''],
    ['Same stage', pctCell(a.stage_pct), a.stage_pct === null ? 'One of the two gives no stages.' : 'Awake, light, deep or REM: share of the night both name the same.'],
    ['Kappa', { v: a.kappa, fmt: '0.00' }, 'Agreement beyond chance. 1 is perfect, 0 no better than guessing.'],
  ];
}

// ---------------------------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------------------------

/** Everything about one session: the comparison, each device's numbers and every reading. */
export function sessionWorkbook(s: SessionRow, recordings: RecordingRow[], opts: ExportOptions): ExportFile {
  const c = clockOf(s);
  const summary = summaryOf(s);
  const pairs = summary?.pairs ?? [];
  const name = (r: RecordingRow) => r.device_label || r.source_name;
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const roleOf = (r: RecordingRow) => pairs.some((p) => p.test === r.id) ? 'Under test'
    : pairs.some((p) => p.reference === r.id) ? 'Reference'
    : r.logged ? 'Not compared' : 'Background';
  const sheets: { sheet: Sheet; about: string }[] = [];
  const add = (sheet: Sheet, about: string) => { if (sheet.rows.length) sheets.push({ sheet, about }); };

  // Side by side, every pair.
  add({
    name: 'Comparison',
    header: ['Under test', 'Reference', 'Measure', 'Reference value', 'Under test value', 'Difference', 'Difference %', 'Verdict', 'Note'],
    rows: pairs.flatMap((p) => { const [t, r] = pairNames(summary, p); return p.rows.map((row) => [t, r, ...comparisonCells(c, row, t, r)]); }),
  }, 'Every number both devices reported, side by side. Difference is the device under test minus the reference.');

  add({
    name: 'Agreement',
    header: ['Under test', 'Reference', 'Measure', 'Value', 'What it means'],
    rows: pairs.flatMap((p) => {
      const [t, r] = pairNames(summary, p);
      const lines = [...(p.hr ? hrAgreementRows(c, p.hr, t, r) : []), ...(p.sleep ? sleepAgreementRows(c, p.sleep, t, r) : [])];
      return lines.map(([label, value, means]): CellInput[] => [t, r, label, value, { v: means, wrap: true }]);
    }),
    widths: [undefined, undefined, undefined, 14, 70],
  }, s.kind === 'sleep' ? 'How well the two nights agree, 30 seconds at a time.' : 'How closely the heart rate lines agree, half-minute by half-minute.');

  // The stage table: minutes of the night by what each device said.
  const tables: CellInput[][] = [];
  for (const p of pairs) {
    if (!p.sleep?.confusion) continue;
    const [t, r] = pairNames(summary, p);
    if (tables.length) tables.push([]);
    tables.push([{ v: `Minutes of the night: rows are what ${r} says, columns what ${t} says. The diagonal is where they agree.`, bold: true }]);
    tables.push([{ v: `${r} ↓  ${t} →`, bold: true }, ...p.sleep.labels.map((l) => ({ v: l, bold: true }))]);
    p.sleep.confusion.forEach((row, i) => tables.push([{ v: p.sleep!.labels[i]!, bold: true }, ...row.map((n) => ({ v: n / 2, fmt: '#,##0.0' }))]));
  }
  add({ name: 'Stage table', rows: tables, widths: [28, 12, 12, 12, 12] }, 'Where the sleep stages agree: minutes of the night by what each device said.');

  // Each device's own numbers.
  const fromText = (m: MetricValue, logged: boolean) => {
    if (m.at !== undefined) return `Its own estimate, the reading of ${new Date((m.at + s.utc_offset_min * 60) * 1000).toISOString().slice(0, 16).replace('T', ' ')}: not measured during the session`;
    if (m.basis && m.from !== 'manual') {
      const over = m.over_s !== undefined ? ` ${m.over_s < 90 ? `${m.over_s} s` : `${Math.round(m.over_s / 60)} min`}` : '';
      return m.basis === 'route' ? `The fastest${over} of its GPS track` : m.basis === 'distance' ? `The fastest${over} of its distance readings` : m.from === 'summary' ? 'From the device’s own top speed' : 'From its top speed reading';
    }
    const base = m.from === 'summary' ? 'The device’s own total' : m.from === 'manual' ? 'Entered by hand, read off its app'
      : m.from === 'derived' ? 'Worked out from its other numbers' : m.agg === 'sum' ? 'Added up from its readings' : 'Averaged from its readings';
    return base + (m.approx ? '; an estimate, its totals straddle the session' : '') + (m.from === 'samples' && !logged ? ', during the session' : '');
  };
  add({
    name: 'Measures',
    header: ['Device', 'Measure', 'Value', 'Lowest', 'Highest', 'Highest at', 'Readings', 'Where it comes from'],
    rows: recordings.flatMap((r) => Object.entries(r.metrics).sort(([a], [b]) => metricRank(a) - metricRank(b) || a.localeCompare(b)).map(([key, m]): CellInput[] => [
      name(r), measureLabel(metricLabel(key, m), m.unit), c.value(m.value, m.unit), c.value(m.min, m.unit), c.value(m.max, m.unit), c.at(m.max_at, 'hh:mm:ss'), m.n ?? null, fromText(m, r.logged),
    ])),
  }, 'Every total and average each device has for the session, including what only one device reported.');

  add({
    name: 'Devices',
    header: ['Device', 'Brand', 'Role', 'Logged the session', 'Recorded as', 'Started', 'Ended', 'Length', 'Written to Health by', 'App version', 'Hardware',
      'Heart rate readings', 'One reading every', 'Heart rate covers', 'First reading after', 'No heart rate for', 'Same value held 40 s+', 'Body weight in its app', 'Entered by hand'],
    rows: recordings.map((r): CellInput[] => {
      const q = r.details.hr ?? null;
      const d = r.details.device ?? {};
      const manual = r.details.manual;
      const mmss = (v: number) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')} /km`;
      const typed = manual ? [manual.distance_km != null ? `distance ${manual.distance_km} km` : '', manual.active_kcal != null ? `active calories ${manual.active_kcal} kcal` : '', manual.max_pace_s != null ? `max pace ${mmss(manual.max_pace_s)}` : ''].filter(Boolean).join(', ') + (manual.by ? ` (by ${manual.by})` : '') : '';
      return [
        name(r), tagLabel(r.device_tag), roleOf(r), r.logged ? 'Yes' : 'No, readings only',
        r.logged ? (s.kind === 'sleep' ? 'Night' : activityLabel(r.activity)) : '',
        r.logged ? c.at(r.started_at) : null, r.logged ? c.at(r.ended_at) : null, r.logged ? c.length(r.ended_at - r.started_at) : null,
        r.source_name, r.source_version ?? '', [d.name, d.manufacturer, d.model, d.hardware].filter(Boolean).join(', '),
        q?.samples ?? 0, q ? { v: q.interval_s, fmt: numberFormat('s', false, 1) } : null, q ? pctCell(q.coverage_pct) : null,
        q ? { v: q.first_after_s, fmt: numberFormat('s', false, 0) } : null, q ? c.length(q.gap_s) : null, q ? c.length(q.held_s) : null,
        r.details.profile?.weight_kg ? { v: r.details.profile.weight_kg, fmt: numberFormat('kg') } : null, typed,
      ];
    }),
  }, 'Each device: its brand, its role in the comparison, when it recorded and how complete its heart rate is.');

  // Heart rate on one clock, averaged as the session page draws it, then every reading.
  const hr = recordings.filter((r) => r.series.heart_rate?.t.length);
  if (hr.length) {
    // The span the page draws: each device's own recording, plus up to two minutes of readings either side.
    const edges = hr.map((r) => {
      const sr = r.series.heart_rate!, a = r.logged ? r.started_at : s.started_at, b = r.logged ? r.ended_at : s.ended_at;
      return [Math.min(a, Math.max(a - 120, sr.t0)), Math.max(b, Math.min(b + 120, sr.t0 + sr.t[sr.t.length - 1]!))] as const;
    });
    const from = Math.min(...edges.map((e) => e[0])), to = Math.max(...edges.map((e) => e[1]));
    const step = stepFor(to - from);
    const g0 = Math.floor(from / step) * step;
    const grids = hr.map((r) => bucketMeans(r.series.heart_rate!, g0, to, step));
    const lead = pairs.find((p) => p.hr && hr.some((r) => r.id === p.test) && hr.some((r) => r.id === p.reference));
    const ti = lead ? hr.findIndex((r) => r.id === lead.test) : -1, ri = lead ? hr.findIndex((r) => r.id === lead.reference) : -1;
    const rows: CellInput[][] = [];
    for (let i = 0; i < (grids[0]?.length ?? 0); i++) {
      const values = grids.map((g) => g[i] ?? null);
      if (values.every((v) => v === null)) continue;
      const at = g0 + i * step;
      const diff = lead && values[ti] !== null && values[ri] !== null ? values[ti]! - values[ri]! : null;
      rows.push([c.at(at), c.since(at), ...values.map((v) => ({ v: v === null ? null : Math.round(v * 10) / 10, fmt: '0.0' })), ...(lead ? [{ v: diff === null ? null : Math.round(diff * 10) / 10, fmt: '+0.0;-0.0;0.0' }] : [])]);
    }
    add({
      name: 'Heart rate',
      header: ['Time', 'Since the start', ...hr.map((r) => `${name(r)} (bpm)`), ...(lead ? [`${name(byId.get(lead.test)!)} minus ${name(byId.get(lead.reference)!)} (bpm)`] : [])],
      rows,
    }, `Heart rate on one clock: the average of each ${step} seconds, as the session page draws it. Blank where a device had no reading.`);

    const readings: [number, string, number, number][] = [];
    for (const r of hr) {
      const sr = r.series.heart_rate!;
      for (let i = 0; i < sr.t.length; i++) readings.push([sr.t0 + sr.t[i]!, name(r), sr.v[i]!, sr.d ? sr.d[i]! : 0]);
    }
    readings.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    const lasting = readings.some((x) => x[3] > 0);
    add({
      name: 'Heart rate readings',
      header: ['Time', 'Since the start', 'Device', 'Heart rate (bpm)', ...(lasting ? ['Over (s)'] : [])],
      rows: readings.map(([at, who, v, d]) => [c.at(at), c.since(at), who, v, ...(lasting ? [d || null] : [])]),
    }, 'Every heart rate reading each device wrote to Apple Health, as written.');

    const issues: CellInput[][] = [];
    for (const r of hr) {
      const q = r.details.hr;
      if (!q) continue;
      for (const h of q.holds) issues.push([name(r), 'Same value held', c.at(h.t0), c.at(h.t1), c.length(h.t1 - h.t0), h.value]);
      for (const g of q.gaps) issues.push([name(r), 'No reading', c.at(g.t0), c.at(g.t1), c.length(g.t1 - g.t0), null]);
    }
    issues.sort((a, b) => ((a[2] as Cell).v as number) - ((b[2] as Cell).v as number));
    add({ name: 'Heart rate issues', header: ['Device', 'What', 'From', 'To', 'Length', 'Value (bpm)'], rows: issues },
      'Stretches where a device reported the exact same bpm for 40 seconds or more, and where it wrote no heart rate.');

    if (s.kind === 'workout') {
      const zoned = hr.filter((r) => r.details.hr?.zones?.length);
      add({
        name: 'Heart rate ranges',
        header: ['Device', ...(summary?.zone_labels ?? ZONE_LABELS).map((l) => `${l} bpm`)],
        rows: zoned.map((r) => [name(r), ...r.details.hr!.zones.map((z) => pctCell(z))]),
      }, 'Share of the session each device spent in each heart rate range.');
    }
  }

  add({
    name: 'Sleep stages',
    header: ['Device', 'Stage', 'From', 'To', 'Length'],
    rows: recordings.flatMap((r) => (r.stages?.runs ?? []).map(([off, len, stage]): CellInput[] => [name(r), STAGE_LABEL[stage] ?? stage, c.at(r.stages!.t0 + off), c.at(r.stages!.t0 + off + len), c.length(len)])),
  }, 'Each device’s night as a run of stages, on 30-second steps.');

  const other: CellInput[][] = [];
  for (const r of recordings) {
    for (const [key, sr] of Object.entries(r.series).sort(([a], [b]) => metricRank(a) - metricRank(b) || a.localeCompare(b))) {
      if (key === 'heart_rate') continue;
      for (let i = 0; i < sr.t.length; i++) {
        const at = sr.t0 + sr.t[i]!, d = sr.d ? sr.d[i]! : 0;
        other.push([name(r), sr.label, c.at(at), d > 0 ? c.at(at + d) : null, c.since(at), sr.v[i]!, sr.unit]);
      }
    }
  }
  add({ name: 'Other readings', header: ['Device', 'Measure', 'From', 'To', 'Since the start', 'Value', 'Unit'], rows: other },
    'Everything else the devices wrote to Apple Health during the session (steps, calories, distance…), reading by reading.');

  add({
    name: 'Route',
    header: ['Device', 'Time', 'Since the start', 'Latitude', 'Longitude', 'Elevation (m)', 'Speed (m/s)'],
    rows: recordings.flatMap((r) => {
      const rt = r.route;
      if (!rt) return [];
      return rt.t.map((t, i): CellInput[] => [name(r), c.at(rt.t0 + t), c.since(rt.t0 + t), { v: rt.lat[i] ?? null, fmt: '0.000000' }, { v: rt.lon[i] ?? null, fmt: '0.000000' }, rt.ele?.[i] ?? null, rt.speed?.[i] ?? null]);
    }),
  }, 'The GPS track each device wrote, as stored (at most 2,000 points per device).');

  // The first sheet: what the session is, the headline, and what each other sheet holds.
  const rows: CellInput[][] = [];
  const kv = (label: string, value: CellInput) => rows.push([{ v: label, bold: true }, value]);
  const wrap = (text: string): Cell => ({ v: text, wrap: true });
  rows.push([{ v: `Luna benchmark ${s.ref}`, bold: true }], []);
  kv('Session', s.ref);
  kv('Link', linkOf(opts.baseUrl, s.ref));
  kv('What', whatOf(s));
  if (s.title) kv('Title', s.title);
  kv('Worn by', s.tester);
  kv('Luna firmware', s.firmware_version ?? 'Not entered');
  kv('Luna app version', s.app_version ?? 'Not entered');
  kv('Phone', s.platform ? PLATFORM[s.platform]! : 'Not entered');
  kv('Started', c.at(s.started_at));
  kv('Ended', c.at(s.ended_at));
  kv('Length', c.length(s.ended_at - s.started_at));
  kv('Times are', `The wearer’s clock, ${offsetLabel(s.utc_offset_min)}`);
  kv('Devices', wrap(recordings.map((r) => `${name(r)} (${roleOf(r).toLowerCase()})`).join(', ')));
  pairs.forEach((p, i) => { const [t, r] = pairNames(summary, p); kv(i ? '' : 'Compared', `${t} against ${r}`); });
  const lead = summary && summary.primary !== null ? pairs[summary.primary] : undefined;
  if (lead?.hr) {
    kv('Heart rate, typical gap', bpmCell(lead.hr.typical_gap));
    kv('Heart rate, lean', bpmCell(lead.hr.bias, true));
    kv('Heart rate, verdict', VERDICT[lead.hr.verdict]);
  }
  if (lead?.sleep) {
    kv('Asleep or awake: the same', pctCell(lead.sleep.sleep_wake_pct));
    if (lead.sleep.stage_pct !== null) kv('Same stage', pctCell(lead.sleep.stage_pct));
  }
  if (summary?.why) kv('Nothing compared because', summary.why);
  if (summary?.gaps.length) kv('Not compared', wrap(summary.gaps.join(' ')));
  kv('Test data', yes(s.is_test));
  if (s.notes) kv('Notes', wrap(s.notes));
  if (s.screenshots.length) kv('Screenshots', wrap(s.screenshots.map((x) => x.url).join('\n')));
  kv('Imported', `${formatInZone(new Date(s.created_at), opts.timeZone)}${s.uploaded_by ? ` by ${s.uploaded_by}` : ''}`);
  kv('Exported', formatInZone(opts.now ?? new Date(), opts.timeZone));
  if (summary?.findings.length) {
    rows.push([], [{ v: 'What stands out', bold: true }]);
    const level = { good: 'Good', warn: 'Look at this', info: 'Note' } as const;
    for (const f of summary.findings) rows.push([`${level[f.level]}: ${f.title}`, wrap(f.detail)]);
  }
  rows.push([], [{ v: 'In this file', bold: true }]);
  for (const x of sheets) rows.push([x.sheet.name, wrap(x.about)]);

  return {
    filename: `luna-benchmark-${s.ref}-${dayOf(s)}.xlsx`,
    body: workbook([{ name: 'Summary', rows, widths: [34, 100] }, ...sheets.map((x) => x.sheet)]),
  };
}

// ---------------------------------------------------------------------------------------------
// A list of sessions
// ---------------------------------------------------------------------------------------------

/**
 * Many sessions at once, from what each session's summary holds: one line per session, every
 * side-by-side number, the agreement numbers and what stands out. No readings: those are per session.
 */
export function listWorkbook(sessions: SessionRow[], opts: ExportOptions & { filters: [string, string][] }): ExportFile {
  const sessionRows: CellInput[][] = [], comparison: CellInput[][] = [], agreement: CellInput[][] = [], findings: CellInput[][] = [];
  for (const s of sessions) {
    const c = clockOf(s);
    const summary = summaryOf(s);
    const recs = summary?.recordings ?? [];
    const pairs = summary?.pairs ?? [];
    const lead = summary && summary.primary !== null ? pairs[summary.primary] : undefined;
    const [leadTest, leadRef] = lead ? pairNames(summary, lead) : ['', ''];
    const what = whatOf(s);
    const start = c.at(s.started_at);
    sessionRows.push([
      s.ref, start, c.at(s.ended_at), c.length(s.ended_at - s.started_at), s.kind === 'sleep' ? 'Sleep' : 'Workout', what, s.title ?? '', s.tester,
      s.firmware_version ?? '', s.app_version ?? '', s.platform ? PLATFORM[s.platform]! : '',
      recs.filter((r) => r.logged).map((r) => r.label).join(', '), recs.filter((r) => !r.logged).map((r) => r.label).join(', '),
      leadTest, leadRef,
      lead?.hr ? bpmCell(lead.hr.typical_gap) : null, lead?.hr ? bpmCell(lead.hr.bias, true) : null, lead?.hr ? { v: lead.hr.r, fmt: '0.00' } : null, lead?.hr ? VERDICT[lead.hr.verdict] : '',
      lead?.sleep ? pctCell(lead.sleep.sleep_wake_pct) : null, lead?.sleep ? pctCell(lead.sleep.stage_pct) : null,
      summary?.why ?? '', yes(s.is_test), s.notes ?? '', linkOf(opts.baseUrl, s.ref),
    ]);
    for (const p of pairs) {
      const [t, r] = pairNames(summary, p);
      for (const row of p.rows) comparison.push([s.ref, start, what, s.tester, t, r, ...comparisonCells(c, row, t, r)]);
      if (p.hr || p.sleep) {
        const a = p.hr, z = p.sleep;
        agreement.push([
          s.ref, start, what, t, r,
          a ? bpmCell(a.typical_gap) : null, a ? bpmCell(a.median_gap) : null, a ? bpmCell(a.bias, true) : null, a ? { v: a.r, fmt: '0.00' } : null,
          a ? pctCell(a.within_5) : null, a ? pctCell(a.within_10) : null, a ? bpmCell(a.max_gap, true) : null, a ? bpmCell(a.loa_low, true) : null, a ? bpmCell(a.loa_high, true) : null,
          a?.warmup ? bpmCell(a.warmup.bias, true) : null, a?.steady ? bpmCell(a.steady.bias, true) : null, a?.lag_s != null ? { v: a.lag_s, fmt: numberFormat('s', true, 0) } : null, a ? VERDICT[a.verdict] : '',
          z ? pctCell(z.sleep_wake_pct) : null, z ? pctCell(z.stage_pct) : null, z ? pctCell(z.sensitivity) : null, z ? pctCell(z.specificity) : null, z ? { v: z.kappa, fmt: '0.00' } : null,
        ]);
      }
    }
    const level = { good: 'Good', warn: 'Look at this', info: 'Note' } as const;
    for (const f of summary?.findings ?? []) findings.push([s.ref, start, what, level[f.level], f.title, f.detail]);
  }

  const now = opts.now ?? new Date();
  const sheets: { sheet: Sheet; about: string }[] = [
    { sheet: { name: 'Sessions', header: ['Session', 'Started', 'Ended', 'Length', 'Kind', 'What', 'Title', 'Worn by', 'Luna firmware', 'Luna app version', 'Phone', 'Logged by', 'Readings only', 'Under test', 'Reference',
      'Heart rate, typical gap', 'Heart rate, lean', 'Heart rate, correlation', 'Heart rate, verdict', 'Asleep or awake: the same', 'Same stage', 'Nothing compared because', 'Test data', 'Notes', 'Link'], rows: sessionRows },
      about: 'One line per session with its headline comparison (the one its page leads with). Times are each wearer’s own clock.' },
    { sheet: { name: 'Comparison', header: ['Session', 'Started', 'What', 'Worn by', 'Under test', 'Reference', 'Measure', 'Reference value', 'Under test value', 'Difference', 'Difference %', 'Verdict', 'Note'], rows: comparison },
      about: 'Every number two devices both reported, session by session. Difference is the device under test minus the reference. Filter on Measure to line up, say, every distance.' },
    { sheet: { name: 'Agreement', header: ['Session', 'Started', 'What', 'Under test', 'Reference', 'Typical gap', 'Gap on the middle half-minute', 'Lean', 'Correlation', 'Within 5 bpm', 'Within 10 bpm', 'Widest gap',
      '95% of gaps from', '95% of gaps to', 'Lean, first 3 min', 'Lean after that', 'Trails by', 'Heart rate verdict', 'Asleep or awake: the same', 'Same stage', 'Reference sleep also sleep', 'Reference awake also awake', 'Kappa'], rows: agreement },
      about: 'Heart rate agreement (half-minute by half-minute) and sleep agreement (30 seconds at a time), one line per pair of devices.' },
    { sheet: { name: 'Findings', header: ['Session', 'Started', 'What', 'Level', 'Finding', 'Detail'], rows: findings, widths: [undefined, undefined, undefined, undefined, undefined, 90] },
      about: 'What stands out in each session, worked out by fixed rules.' },
  ];
  const about: CellInput[][] = [[{ v: 'Luna benchmarks', bold: true }], []];
  const kv = (label: string, value: CellInput) => about.push([{ v: label, bold: true }, value]);
  kv('Number of sessions', sessions.length);
  kv('Filters', opts.filters.length ? opts.filters.map(([k, v]) => `${k}: ${v}`).join('; ') : 'none');
  kv('Exported', formatInZone(now, opts.timeZone));
  kv('Readings', 'Each session’s heart rate, stages and other readings are in its own export, from its page.');
  about.push([], [{ v: 'In this file', bold: true }]);
  for (const x of sheets) about.push([x.sheet.name, { v: x.about, wrap: true }]);
  return {
    filename: `luna-benchmarks-${todayInZone(opts.timeZone, now)}.xlsx`,
    body: workbook([...sheets.map((x) => x.sheet), { name: 'About', rows: about, widths: [20, 100] }]),
  };
}
