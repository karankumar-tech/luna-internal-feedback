// Reads an Apple Health export where it is: in the browser, as a stream, without uploading it.
// The export (export.zip, or the export.xml inside it) is often hundreds of megabytes, far more than
// a request may carry, and almost all of it is irrelevant. So the page reads it twice:
//   1. scanExport()      lists every workout and every night in the file (small).
//   2. extractSessions() collects the samples recorded during the sessions someone chose to import.
// Only that second, small result is sent to the server. Nothing here depends on the DOM, so the
// same file runs under Node for the tests.
//
// Served at /dashboard/assets/health-export.js (embedded by scripts/embed-pages.mjs).

/** Quantity types worth keeping for a workout: anything about effort, movement or the heart. */
export const WORKOUT_TYPES = /HeartRate|EnergyBurned|Distance|StepCount|FlightsClimbed|Speed|Power|Cadence|StrideLength|VerticalOscillation|GroundContactTime|StrokeCount|VO2Max|RespiratoryRate|OxygenSaturation|Temperature|PhysicalEffort/;
/** For a night only the vitals matter; steps and distance are noise. */
export const SLEEP_TYPES = /HeartRate|RespiratoryRate|OxygenSaturation|Temperature/;

const QUANTITY_PREFIX = 'HKQuantityTypeIdentifier';
const SLEEP_TYPE = 'HKCategoryTypeIdentifierSleepAnalysis';
/** Sleep records of one source closer together than this belong to the same night. */
const NIGHT_GAP_S = 90 * 60;
/** Shorter than this is not a night or a nap worth comparing. */
const NIGHT_MIN_S = 20 * 60;
/** Samples this far outside a session are kept, so a device that started early still shows. */
export const PAD_S = 120;
const MAX_POINTS = 20000;
const MAX_ROUTE_POINTS = 1500;

// ---------------------------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------------------------

/** "2026-09-28 16:18:52 +0530" -> seconds since the epoch. NaN when it is not a date. */
export function parseDate(s) {
  if (!s || s.length < 19) return NaN;
  const utc = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19));
  return utc / 1000 - offsetOf(s) * 60;
}

/** The UTC offset written on a date, in minutes: "+0530" -> 330. */
export function offsetOf(s) {
  if (!s || s.length < 25) return 0;
  const sign = s.charCodeAt(20) === 45 ? -1 : 1;
  const v = sign * (+s.slice(21, 23) * 60 + +s.slice(23, 25));
  return Number.isFinite(v) ? v : 0;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] !== '#') return ENTITIES[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Every attribute of a tag, from the text between its name and its closing bracket. */
export function parseAttrs(body) {
  const out = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(body))) out[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** One attribute, without parsing the rest. The export writes attributes as ` name="value"`. */
function attr(body, name) {
  const key = ' ' + name + '="';
  const i = body.indexOf(key);
  if (i === -1) return undefined;
  const from = i + key.length;
  const to = body.indexOf('"', from);
  return to === -1 ? undefined : unescapeXml(body.slice(from, to));
}

/** "<<HKDevice: 0x…>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.1>" */
export function parseDevice(text) {
  if (!text) return null;
  const out = {};
  for (const key of ['name', 'manufacturer', 'model', 'hardware', 'software']) {
    const m = new RegExp('(?:^|, )' + key + ':(.*?)(?=, [A-Za-z ]+:|>$|$)').exec(text);
    if (m && m[1]) out[key] = m[1].trim().slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Streaming XML: tags only, which is all the export is made of
// ---------------------------------------------------------------------------------------------

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Calls onTag(name, attributeText, isClosing, isSelfClosing) for every element tag in the stream.
 * The document type block, comments and text are skipped. onBytes(n) reports progress.
 */
export async function scanTags(stream, onTag, onBytes) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onBytes) onBytes(value.byteLength);
    const text = carry + decoder.decode(value, { stream: true });
    TAG.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = TAG.exec(text))) {
      last = TAG.lastIndex;
      onTag(m[2], m[3], m[1] === '/', m[4] === '/');
    }
    // A tag cut in half by the chunk boundary waits for the next chunk.
    const lt = text.lastIndexOf('<');
    carry = lt >= last && text.length - lt < 4_000_000 ? text.slice(lt) : '';
  }
}

// ---------------------------------------------------------------------------------------------
// The file: a zip (as the phone shares it) or the bare export.xml
// ---------------------------------------------------------------------------------------------

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const u64 = (v, o) => Number(v.getBigUint64(o, true));

async function view(file, from, to) {
  return new DataView(await file.slice(from, to).arrayBuffer());
}

/** The zip's table of contents: name, sizes and where each entry starts. Handles zip64. */
export async function readZipDirectory(file) {
  const tailFrom = Math.max(0, file.size - 66_000);
  const tail = await view(file, tailFrom, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd === -1) throw new Error('This zip file is incomplete or damaged (no table of contents).');
  let count = u16(tail, eocd + 10);
  let dirSize = u32(tail, eocd + 12);
  let dirOffset = u32(tail, eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('This zip file is too large to read here.');
    const z = await view(file, u64(tail, loc + 8), u64(tail, loc + 8) + 56);
    if (u32(z, 0) !== 0x06064b50) throw new Error('This zip file is incomplete or damaged.');
    count = u64(z, 32); dirSize = u64(z, 40); dirOffset = u64(z, 48);
  }
  const dir = await view(file, dirOffset, dirOffset + dirSize);
  const names = new TextDecoder('utf-8');
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dir.byteLength; i++) {
    if (u32(dir, p) !== 0x02014b50) break;
    const method = u16(dir, p + 10);
    let compressed = u32(dir, p + 20);
    let size = u32(dir, p + 24);
    const nameLen = u16(dir, p + 28), extraLen = u16(dir, p + 30), commentLen = u16(dir, p + 32);
    let offset = u32(dir, p + 42);
    const name = names.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    // zip64: the real sizes sit in an extra field, in this order, only for the saturated values.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(dir, x), len = u16(dir, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(dir, q); q += 8; }
        if (compressed === 0xffffffff) { compressed = u64(dir, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(dir, q); }
      }
      x += 4 + len;
    }
    entries.push({ name, method, compressed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipEntryStream(file, entry) {
  const head = await view(file, entry.offset, entry.offset + 30);
  if (u32(head, 0) !== 0x04034b50) throw new Error('This zip file is incomplete or damaged.');
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = file.slice(start, start + entry.compressed).stream();
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error('This zip uses a compression this page cannot read. Unzip it and choose export.xml instead.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip here. Unzip the file and choose export.xml instead.');
  return raw.pipeThrough(new DecompressionStream('deflate-raw'));
}

/**
 * Opens export.zip or export.xml.
 * Returns { kind, name, xmlSize, xml(): stream, routeText(path): Promise<string|null>, routeCount }.
 */
export async function openExport(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    const start = new TextDecoder().decode(await file.slice(0, 600).arrayBuffer());
    if (start.indexOf('<') === -1) throw new Error('This does not look like an Apple Health export. Choose export.zip, or the export.xml inside it.');
    if (/<ClinicalDocument/.test(start)) throw new Error('This is export_cda.xml, the clinical copy. Choose export.xml (or the whole export.zip) instead.');
    return { kind: 'xml', name: file.name || 'export.xml', xmlSize: file.size, xml: async () => file.stream(), routeText: async () => null, routeCount: 0 };
  }
  const entries = await readZipDirectory(file);
  // The folder and file names are translated on non-English phones, so pick by shape: the largest
  // XML that is not the clinical (CDA) copy.
  const xmls = entries.filter((e) => /\.xml$/i.test(e.name) && !/cda/i.test(e.name) && !/(^|\/)\./.test(e.name));
  xmls.sort((a, b) => b.size - a.size);
  const main = xmls[0];
  if (!main) throw new Error('No export.xml inside this zip. Export again from the Health app: profile picture, then Export All Health Data.');
  const routes = entries.filter((e) => /\.gpx$/i.test(e.name));
  return {
    kind: 'zip',
    name: file.name || 'export.zip',
    xmlSize: main.size,
    xml: () => zipEntryStream(file, main),
    routeCount: routes.length,
    routeText: async (path) => {
      const want = String(path).replace(/^\/+/, '');
      const entry = routes.find((e) => e.name === want || e.name.endsWith('/' + want));
      if (!entry) return null;
      return new Response(await zipEntryStream(file, entry)).text();
    },
  };
}

function progressReporter(total, onProgress) {
  if (!onProgress) return undefined;
  let seen = 0;
  let lastAt = 0;
  return (n) => {
    seen += n;
    const now = Date.now();
    if (now - lastAt < 80) return;
    lastAt = now;
    onProgress(total ? Math.min(1, seen / total) : 0);
  };
}

// ---------------------------------------------------------------------------------------------
// Pass 1: what is in the file
// ---------------------------------------------------------------------------------------------

/** Groups one source's sleep records into nights (and naps): records closer than 90 minutes. */
export function buildNights(records) {
  const bySource = new Map();
  for (const r of records) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r);
  }
  const nights = [];
  for (const [source, list] of bySource) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const recorded = cur.segments.reduce((sum, s) => sum + (s[1] - s[0]), 0);
      if (recorded >= NIGHT_MIN_S) nights.push({ key: `s|${source}|${cur.start}|${cur.end}`, kind: 'sleep', source, sourceVersion: cur.sourceVersion, offsetMin: cur.offsetMin, start: cur.start, end: cur.end, segments: cur.segments });
      cur = null;
    };
    const seen = new Set();
    for (const r of list) {
      if (!(r.end > r.start)) continue;
      const id = r.start + '|' + r.end + '|' + r.value;
      if (seen.has(id)) continue;
      seen.add(id);
      if (cur && r.start - cur.end > NIGHT_GAP_S) flush();
      if (!cur) cur = { start: r.start, end: r.end, segments: [], sourceVersion: r.sourceVersion, offsetMin: r.offsetMin };
      cur.segments.push([r.start, r.end, r.value]);
      if (r.end > cur.end) cur.end = r.end;
    }
    flush();
  }
  nights.sort((a, b) => a.start - b.start);
  return nights;
}

/** "Navay’s iPhone" -> "Navay": a first guess at who wore the devices. */
export function guessTester(sourceNames) {
  for (const name of sourceNames) {
    const m = /^(.+?)[’']s (?:iPhone|Apple Watch|iPad)\b/.exec(name);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Lists every workout and night in the export, per source.
 * Returns { exportDate, offsetMin, workouts, nights, sources, profiles, tester }.
 */
export async function scanExport(src, opts = {}) {
  const workouts = [];
  const sleep = [];
  const sources = new Map();
  const profiles = {};
  let exportDate = null;
  let offsetMin = null;
  let cur = null;

  const finish = () => {
    if (!cur) return;
    if (Number.isFinite(cur.start) && Number.isFinite(cur.end) && cur.end >= cur.start) {
      cur.key = `w|${cur.source}|${cur.start}|${cur.end}`;
      workouts.push(cur);
    }
    cur = null;
  };
  const num = (v) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : undefined; };

  const onTag = (name, body, closing, selfClosing) => {
    if (name === 'Record') {
      if (closing) return;
      const type = attr(body, 'type');
      const source = attr(body, 'sourceName') || 'Unknown';
      let s = sources.get(source);
      if (!s) { s = { name: source, records: 0, heartRate: 0, sleep: 0 }; sources.set(source, s); }
      s.records += 1;
      if (type === QUANTITY_PREFIX + 'HeartRate') s.heartRate += 1;
      else if (type === SLEEP_TYPE) {
        s.sleep += 1;
        const a = parseAttrs(body);
        sleep.push({ source, sourceVersion: a.sourceVersion, start: parseDate(a.startDate), end: parseDate(a.endDate), value: a.value, offsetMin: offsetOf(a.startDate) });
      } else if (type === QUANTITY_PREFIX + 'BodyMass' || type === QUANTITY_PREFIX + 'Height') {
        const a = parseAttrs(body);
        const at = parseDate(a.startDate);
        const value = num(a.value);
        if (value !== undefined && Number.isFinite(at)) {
          const p = profiles[source] || (profiles[source] = {});
          const field = type.endsWith('BodyMass') ? 'weight' : 'height';
          if (!p[field] || p[field].at <= at) p[field] = { value, unit: a.unit || '', at };
        }
      }
      return;
    }
    if (name === 'Workout') {
      if (closing) { finish(); return; }
      finish();
      const a = parseAttrs(body);
      cur = {
        kind: 'workout', source: a.sourceName || 'Unknown', sourceVersion: a.sourceVersion, device: parseDevice(a.device),
        activity: a.workoutActivityType || 'HKWorkoutActivityTypeOther',
        start: parseDate(a.startDate), end: parseDate(a.endDate), offsetMin: offsetOf(a.startDate),
        duration: num(a.duration), durationUnit: a.durationUnit,
        totalDistance: num(a.totalDistance), totalDistanceUnit: a.totalDistanceUnit,
        totalEnergy: num(a.totalEnergyBurned), totalEnergyUnit: a.totalEnergyBurnedUnit,
        stats: [], metadata: {}, events: [], routes: [],
      };
      let s = sources.get(cur.source);
      if (!s) { s = { name: cur.source, records: 0, heartRate: 0, sleep: 0 }; sources.set(cur.source, s); }
      s.workouts = (s.workouts || 0) + 1;
      if (selfClosing) finish();
      return;
    }
    if (name === 'ExportDate') {
      const v = attr(body, 'value');
      exportDate = parseDate(v);
      offsetMin = offsetOf(v);
      return;
    }
    if (!cur || closing) return;
    if (name === 'WorkoutStatistics') {
      const a = parseAttrs(body);
      // The export repeats a workout's children; keep the first of each type.
      if (a.type && !cur.stats.some((x) => x.type === a.type) && cur.stats.length < 40) {
        cur.stats.push({ type: a.type, unit: a.unit, sum: num(a.sum), average: num(a.average), minimum: num(a.minimum), maximum: num(a.maximum) });
      }
    } else if (name === 'MetadataEntry') {
      const a = parseAttrs(body);
      if (a.key && Object.keys(cur.metadata).length < 40) cur.metadata[a.key.slice(0, 80)] = String(a.value ?? '').slice(0, 200);
    } else if (name === 'WorkoutEvent') {
      const a = parseAttrs(body);
      const at = parseDate(a.date);
      if (cur.events.length < 200 && Number.isFinite(at) && !cur.events.some((e) => e.type === a.type && e.at === at)) {
        cur.events.push({ type: a.type, at, duration: num(a.duration), durationUnit: a.durationUnit });
      }
    } else if (name === 'FileReference') {
      const path = attr(body, 'path');
      if (path && !cur.routes.includes(path)) cur.routes.push(path);
    }
  };

  await scanTags(await src.xml(), onTag, progressReporter(src.xmlSize, opts.onProgress));
  finish();

  // A workout written more than once (apps re-sync) is one workout.
  const seen = new Set();
  const unique = workouts.filter((w) => (seen.has(w.key) ? false : (seen.add(w.key), true)));
  unique.sort((a, b) => a.start - b.start);
  const nights = buildNights(sleep.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end)));
  const sourceList = [...sources.values()].sort((a, b) => b.records - a.records);
  const lastOffset = unique.length ? unique[unique.length - 1].offsetMin : nights.length ? nights[nights.length - 1].offsetMin : 0;
  return {
    exportDate, offsetMin: offsetMin ?? lastOffset,
    workouts: unique, nights, sources: sourceList, profiles,
    tester: guessTester(sourceList.map((s) => s.name)),
  };
}

// ---------------------------------------------------------------------------------------------
// Pass 2: the samples recorded during the chosen sessions
// ---------------------------------------------------------------------------------------------

function toKg(p) { if (!p) return undefined; const u = p.unit.toLowerCase(); return u === 'lb' ? p.value * 0.45359237 : u === 'g' ? p.value / 1000 : u === 'st' ? p.value * 6.35029 : p.value; }
function toCm(p) { if (!p) return undefined; const u = p.unit.toLowerCase(); return u === 'm' ? p.value * 100 : u === 'in' ? p.value * 2.54 : u === 'ft' ? p.value * 30.48 : p.value; }

/** Too many points to send: average them into equal time buckets (samples), or keep as they are (intervals). */
function thin(series) {
  const n = series.s.length;
  if (n <= MAX_POINTS) return series;
  const isPoint = series.e === null;
  if (!isPoint) {
    const step = Math.ceil(n / MAX_POINTS);
    // Merge neighbours: totals stay right, only the time detail coarsens.
    const s = [], e = [], v = [];
    for (let i = 0; i < n; i += step) {
      let sum = 0, end = series.e[i];
      for (let j = i; j < Math.min(n, i + step); j++) { sum += series.v[j]; if (series.e[j] > end) end = series.e[j]; }
      s.push(series.s[i]); e.push(end); v.push(sum);
    }
    return { ...series, s, e, v };
  }
  const span = series.s[n - 1] - series.s[0] || 1;
  const width = Math.ceil(span / MAX_POINTS);
  const s = [], v = [];
  let bucket = -1, sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.floor((series.s[i] - series.s[0]) / width);
    if (b !== bucket) { if (count) { s.push(series.s[0] + bucket * width); v.push(Math.round((sum / count) * 100) / 100); } bucket = b; sum = 0; count = 0; }
    sum += series.v[i]; count += 1;
  }
  if (count) { s.push(series.s[0] + bucket * width); v.push(Math.round((sum / count) * 100) / 100); }
  return { ...series, s, e: null, v };
}

/** A GPX track as columns, thinned to at most 1,500 points. */
export function parseGpx(text) {
  const t = [], lat = [], lon = [], ele = [], speed = [];
  const point = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = point.exec(text))) {
    const a = parseAttrs(m[1]);
    const la = Number(a.lat), lo = Number(a.lon);
    const time = /<time>([^<]+)<\/time>/.exec(m[2]);
    const at = time ? Date.parse(time[1]) / 1000 : NaN;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !Number.isFinite(at)) continue;
    const el = /<ele>([^<]+)<\/ele>/.exec(m[2]);
    const sp = /<speed>([^<]+)<\/speed>/.exec(m[2]);
    t.push(Math.round(at)); lat.push(la); lon.push(lo);
    ele.push(el && Number.isFinite(+el[1]) ? Math.round(+el[1] * 10) / 10 : null);
    speed.push(sp && Number.isFinite(+sp[1]) ? Math.round(+sp[1] * 100) / 100 : null);
  }
  const n = t.length;
  if (n < 2) return null;
  const step = Math.ceil(n / MAX_ROUTE_POINTS);
  const keep = [];
  for (let i = 0; i < n; i += step) keep.push(i);
  if (keep[keep.length - 1] !== n - 1) keep.push(n - 1);
  const pick = (arr) => keep.map((i) => arr[i]);
  const t0 = t[0];
  return {
    t0, points: n,
    t: pick(t).map((x) => x - t0),
    lat: pick(lat).map((x) => Math.round(x * 1e6) / 1e6),
    lon: pick(lon).map((x) => Math.round(x * 1e6) / 1e6),
    ele: ele.some((x) => x !== null) ? pick(ele) : null,
    speed: speed.some((x) => x !== null) ? pick(speed) : null,
  };
}

/**
 * Collects what every source recorded during each session.
 *
 * sessions: [{ id, kind: 'workout' | 'sleep', start, end, members: [workout or night from scanExport] }]
 * Returns one payload per session, in the same order, ready for POST /v1/admin/benchmarks/import.
 */
export async function extractSessions(src, sessions, scan, opts = {}) {
  const windows = sessions
    .map((s, index) => ({ index, kind: s.kind, a: s.start - PAD_S, b: s.end + PAD_S, start: s.start, end: s.end, bySource: new Map() }))
    .sort((x, y) => x.a - y.a);
  const maxB = [];
  windows.forEach((w, i) => { maxB[i] = i ? Math.max(maxB[i - 1], w.b) : w.b; });
  const lo = windows.length ? windows[0].a : 0;
  const hi = windows.length ? maxB[maxB.length - 1] : 0;

  const onTag = (name, body, closing) => {
    if (name !== 'Record' || closing) return;
    const type = attr(body, 'type');
    if (!type || !type.startsWith(QUANTITY_PREFIX) || !WORKOUT_TYPES.test(type)) return;
    const s = parseDate(attr(body, 'startDate'));
    if (!(s <= hi)) return;
    const endText = attr(body, 'endDate');
    const e = endText ? parseDate(endText) : s;
    if (!(e >= lo)) return;
    // Last window starting at or before the record's end, then walk back while any could still reach it.
    let l = 0, r = windows.length - 1, at = -1;
    while (l <= r) { const mid = (l + r) >> 1; if (windows[mid].a <= e) { at = mid; l = mid + 1; } else r = mid - 1; }
    let parsed = null;
    for (let i = at; i >= 0 && maxB[i] >= s; i--) {
      const w = windows[i];
      if (w.b < s) continue;
      if (w.kind === 'sleep' && !SLEEP_TYPES.test(type)) continue;
      if (!parsed) {
        const value = Number(attr(body, 'value'));
        if (!Number.isFinite(value)) return;
        parsed = { source: attr(body, 'sourceName') || 'Unknown', value, unit: attr(body, 'unit') || '' };
      }
      let rec = w.bySource.get(parsed.source);
      if (!rec) { rec = { version: attr(body, 'sourceVersion'), device: parseDevice(attr(body, 'device')), types: new Map() }; w.bySource.set(parsed.source, rec); }
      let series = rec.types.get(type);
      if (!series) { series = { unit: parsed.unit, s: [], e: [], v: [], seen: new Set() }; rec.types.set(type, series); }
      // Apps re-sync: the same sample can be in the export several times.
      const id = s + '|' + e + '|' + parsed.value;
      if (series.seen.has(id)) continue;
      series.seen.add(id);
      series.s.push(s); series.e.push(e); series.v.push(parsed.value);
    }
  };

  if (windows.length) await scanTags(await src.xml(), onTag, progressReporter(src.xmlSize, opts.onProgress));

  const out = new Array(sessions.length);
  for (const w of windows) {
    const session = sessions[w.index];
    const recordings = [];
    const loggedSources = new Set();
    for (const member of session.members) {
      loggedSources.add(member.source);
      const rec = w.bySource.get(member.source);
      const recording = {
        source: member.source,
        source_version: member.sourceVersion || (rec && rec.version) || null,
        device: member.device || (rec && rec.device) || null,
        logged: true,
        samples: samplesOf(rec),
      };
      if (member.kind === 'workout') {
        recording.workout = {
          activity: member.activity, start: member.start, end: member.end,
          duration: member.duration ?? null, duration_unit: member.durationUnit || null,
          total_distance: member.totalDistance ?? null, total_distance_unit: member.totalDistanceUnit || null,
          total_energy: member.totalEnergy ?? null, total_energy_unit: member.totalEnergyUnit || null,
          stats: member.stats, metadata: member.metadata, events: member.events,
        };
        for (const path of member.routes || []) {
          const text = await src.routeText(path).catch(() => null);
          const route = text ? parseGpx(text) : null;
          if (route) { recording.route = route; break; }
        }
      } else {
        recording.sleep = { start: member.start, end: member.end, segments: member.segments };
      }
      const profile = profileOf(scan, member.source);
      if (profile) recording.profile = profile;
      recordings.push(recording);
    }
    // A source that logged nothing itself but has samples inside the session (the phone counting
    // steps during a run, a band that writes heart rate without a workout) is still a recording.
    for (const [source, rec] of w.bySource) {
      if (loggedSources.has(source)) continue;
      const samples = samplesOf(rec, w.start, w.end);
      if (!Object.keys(samples).length) continue;
      const recording = { source, source_version: rec.version || null, device: rec.device || null, logged: false, samples };
      const profile = profileOf(scan, source);
      if (profile) recording.profile = profile;
      recordings.push(recording);
    }
    out[w.index] = { kind: session.kind, start: w.start, end: w.end, utc_offset_min: session.members[0] ? session.members[0].offsetMin : 0, recordings };
  }
  return out;
}

function profileOf(scan, source) {
  const p = scan && scan.profiles && scan.profiles[source];
  if (!p) return null;
  const weight = toKg(p.weight), height = toCm(p.height);
  const out = {};
  // Apps do write nonsense here (a height of 7,407 cm has been seen); a body nobody has is left out.
  if (weight >= 20 && weight <= 400) out.weight_kg = Math.round(weight * 10) / 10;
  if (height >= 50 && height <= 260) out.height_cm = Math.round(height * 10) / 10;
  return Object.keys(out).length ? out : null;
}

/** Columns per type, sorted by time. With from/to, only types that have something inside that span. */
function samplesOf(rec, from, to) {
  const out = {};
  if (!rec) return out;
  for (const [type, series] of rec.types) {
    const order = series.s.map((_, i) => i).sort((a, b) => series.s[a] - series.s[b] || series.e[a] - series.e[b]);
    if (!order.length) continue;
    if (from !== undefined && !order.some((i) => series.e[i] >= from && series.s[i] <= to)) continue;
    const s = order.map((i) => series.s[i]);
    const e = order.map((i) => series.e[i]);
    const v = order.map((i) => series.v[i]);
    const isPoint = e.every((x, i) => x === s[i]);
    const t0 = s[0];
    const thinned = thin({ unit: series.unit, s: s.map((x) => x - t0), e: isPoint ? null : e.map((x) => x - t0), v });
    out[type] = { unit: thinned.unit, t0, s: thinned.s, e: thinned.e, v: thinned.v };
  }
  return out;
}
