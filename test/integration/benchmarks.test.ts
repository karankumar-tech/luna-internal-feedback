import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { BenchmarksRepo } from '../../src/modules/benchmarks/benchmarks.repo.js';
import { BenchmarksService } from '../../src/modules/benchmarks/benchmarks.service.js';

/**
 * Device benchmarks: importing what an export's devices recorded, recognising a second upload,
 * a device joining a stored session, re-tagging, and who may do what. Sessions are is_test, belong
 * to a tester named for this run, and are removed afterwards.
 */
const DOMAIN = 'luna-bench-test.invalid';
const run = `${Date.now()}`;
const TESTER = `zz-bench-${run}`;
// Source names carry the run, so a fingerprint never collides with another run's rows.
const POLAR = `Polar Flow ${run}`, LUNA = `Luna ${run}`, PHONE = `iPhone ${run}`;
const OURA = `Oura ${run}`, LIFEOS = `LifeOS ${run}`;
const T0 = 1_790_000_000 + (Number(run) % 100_000) * 10_000;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent' });
const admin = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appKey = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };
const email = (who: string) => `${who}+${run}@${DOMAIN}`;

const cookies: Record<string, string> = {};
async function account(who: string, role: string) {
  const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: admin, payload: { email: email(who), role, name: who } })).json().generated_password;
  const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email(who), password: pass } });
  cookies[who] = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}
const as = (who: string) => ({ ...dash, cookie: cookies[who]! });

const heartRate = (start: number, seconds: number, step: number, f: (t: number) => number) => {
  const s: number[] = [], v: number[] = [];
  for (let t = 0; t <= seconds; t += step) { s.push(t); v.push(Math.round(f(t)) + (t % 3) - 1); }
  return { unit: 'count/min', t0: start, s, e: null, v };
};
const workout = (start: number, end: number, km: number, kcal: number) => ({
  activity: 'HKWorkoutActivityTypeRunning', start, end, duration: (end - start) / 60, duration_unit: 'min',
  stats: [{ type: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal', sum: kcal }, { type: 'HKQuantityTypeIdentifierDistanceWalkingRunning', unit: 'km', sum: km }],
  metadata: { HKIndoorWorkout: '0' }, events: [],
});
const polarRec = (t: number) => ({ source: POLAR, source_version: '1190', logged: true, samples: { HKQuantityTypeIdentifierHeartRate: heartRate(t, 1200, 1, (x) => 150 + 20 * Math.sin(x / 120)) }, workout: workout(t, t + 1200, 3.0, 300), profile: { weight_kg: 80 } });
const lunaRec = (t: number) => ({ source: LUNA, logged: true, samples: { HKQuantityTypeIdentifierHeartRate: heartRate(t + 10, 1180, 2, (x) => 147 + 20 * Math.sin((x + 10) / 120)) }, workout: workout(t + 10, t + 1190, 2.97, 110), profile: { weight_kg: 46 } });
const phoneRec = (t: number) => ({ source: PHONE, logged: false, device: { name: 'iPhone', hardware: 'iPhone16,2' }, samples: { HKQuantityTypeIdentifierStepCount: { unit: 'count', t0: t, s: [0, 600], e: [600, 1200], v: [900, 950] } } });
const body = (t: number, recordings: unknown[], over: Record<string, unknown> = {}) => ({ tester: TESTER, kind: 'workout', start: t, end: t + 1200, utc_offset_min: 330, is_test: true, recordings, ...over });
const post = (payload: unknown, headers: Record<string, string> = admin) => app.inject({ method: 'POST', url: '/v1/admin/benchmarks/import', headers, payload: payload as object });
const get = async (ref: string) => (await app.inject({ method: 'GET', url: `/v1/admin/benchmarks/${ref}`, headers: admin })).json();

async function cleanup() {
  await app.db.query(`delete from luna_feedback.benchmark_sessions where tester like 'zz-bench-%'`);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
  await account('qc', 'qc');
  await account('biz', 'business');
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('importing a session', () => {
  let ref = '';

  it('stores one device, with its numbers worked out and nothing to compare yet', async () => {
    const r = await post(body(T0, [polarRec(T0), phoneRec(T0)]), as('qc'));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'created', added: [POLAR, PHONE], skipped: [] });
    ref = r.json().session.ref;
    expect(ref).toMatch(/^BM-\d{4,}$/);

    const s = await get(ref);
    expect(s).toMatchObject({ kind: 'workout', activity: 'running', tester: TESTER, is_test: true, duration_s: 1200, uploaded_by: email('qc'), devices: ['phone', 'polar'] });
    expect(s.summary).toMatchObject({ pairs: [], primary: null, why: 'Only Polar recorded it: no Luna' });
    expect(s.summary.recordings.map((x: { tag: string; logged: boolean; hr: boolean }) => [x.tag, x.logged, x.hr])).toEqual([['polar', true, true], ['phone', false, false]]);
    const polar = s.recordings[0];
    expect(polar).toMatchObject({ source_name: POLAR, device_tag: 'polar', tag_label: 'Polar', logged: true });
    expect(polar.metrics).toMatchObject({ duration: { value: 1200 }, distance: { value: 3, from: 'summary' }, active_energy: { value: 300 }, pace: { value: 400 } });
    expect(polar.metrics.heart_rate.n).toBe(1201);
    expect(polar.details.hr).toMatchObject({ samples: 1201, interval_s: 1, coverage_pct: 100 });
    expect(polar.series.heart_rate.v).toHaveLength(1201);
    // The phone logged nothing itself: background, with the steps it counted during the run.
    expect(s.recordings[1]).toMatchObject({ source_name: PHONE, device_tag: 'phone', logged: false, metrics: { steps: { value: 1850 } } });
  });

  it('recognises the same export uploaded again', async () => {
    const candidates = [{ key: 'a', kind: 'workout', source: POLAR, activity: 'HKWorkoutActivityTypeRunning', start: T0, end: T0 + 1200 }];
    const check = (await app.inject({ method: 'POST', url: '/v1/admin/benchmarks/check', headers: admin, payload: { tester: TESTER, candidates } })).json();
    expect(check.groups).toHaveLength(1);
    expect(check.groups[0]).toMatchObject({ status: 'imported', session: { ref }, members: [{ key: 'a', status: 'imported', tag: 'polar' }] });

    const again = await post(body(T0, [polarRec(T0), phoneRec(T0)]));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'unchanged', session: { ref }, added: [] });
    expect((await get(ref)).recordings).toHaveLength(2);
  });

  it('adds Luna to the stored session when a later export has it, and compares', async () => {
    const candidates = [
      { key: 'p', kind: 'workout', source: POLAR, start: T0, end: T0 + 1200 },
      { key: 'l', kind: 'workout', source: LUNA, start: T0 + 10, end: T0 + 1190 },
      { key: 'other', kind: 'workout', source: LUNA, start: T0 + 50_000, end: T0 + 51_000 },
    ];
    const check = (await app.inject({ method: 'POST', url: '/v1/admin/benchmarks/check', headers: as('qc'), payload: { tester: TESTER, candidates } })).json();
    expect(check.groups.map((g: { status: string }) => g.status)).toEqual(['adds_device', 'new']);
    expect(check.groups[0].members.map((m: { key: string; status: string; tag: string }) => [m.key, m.status, m.tag])).toEqual([['p', 'imported', 'polar'], ['l', 'new', 'luna']]);

    // The page sends only what is new; the stored device's samples ride along and are skipped.
    const r = await post(body(T0, [lunaRec(T0), { ...polarRec(T0), logged: false, workout: undefined }]));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'updated', session: { ref }, added: [LUNA], skipped: [POLAR] });

    const s = await get(ref);
    expect(s.devices).toEqual(['luna', 'phone', 'polar']);
    expect(s.recordings.map((x: { device_tag: string }) => x.device_tag)).toEqual(['luna', 'polar', 'phone']);
    const [luna, polar] = s.recordings;
    expect(s.summary.pairs).toHaveLength(1);
    const pair = s.summary.pairs[0];
    expect(pair).toMatchObject({ test: luna.id, reference: polar.id, hr: { verdict: 'match', blocks: 40 } });
    expect(pair.hr.bias).toBeCloseTo(-3, 0);
    const row = (key: string) => pair.rows.find((x: { key: string }) => x.key === key);
    expect(row('distance')).toMatchObject({ reference: 3, test: 2.97, verdict: 'match' });
    expect(row('active_energy')).toMatchObject({ verdict: 'not_comparable' });
    expect(s.summary.headline).toMatchObject({ test: 'luna', reference: 'polar' });
    expect(s.summary.findings.map((f: { title: string }) => f.title)).toContain('Calories are not comparable');
  });

  it('redoes a stored session whose numbers came from an older version of the analysis', async () => {
    await app.db.query(`update luna_feedback.benchmark_sessions set summary = jsonb_set(summary - 'gaps', '{version}', '1') where ref = $1`, [ref]);
    const listed = (await app.inject({ method: 'GET', url: `/v1/admin/benchmarks?tester=${encodeURIComponent(TESTER)}&is_test=true`, headers: admin })).json();
    expect(listed.items[0].summary).toMatchObject({ version: 3, gaps: [], why: null });
    await app.db.query(`update luna_feedback.benchmark_sessions set summary = jsonb_set(summary - 'gaps', '{version}', '1') where ref = $1`, [ref]);
    expect((await get(ref)).summary).toMatchObject({ version: 3, gaps: [], why: null });
  });

  it('lists sessions, filtered by device, tester and kind', async () => {
    const list = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/admin/benchmarks?tester=${encodeURIComponent(TESTER)}&${q}`, headers: as('biz') })).json();
    const all = await list('is_test=true');
    expect(all.total).toBe(1);
    expect(all.items[0]).toMatchObject({ ref, devices: ['luna', 'phone', 'polar'] });
    expect(all.items[0].recordings).toBeUndefined();
    expect(all.facets.testers).toContain(TESTER);
    expect((await list('is_test=true&device=luna')).total).toBe(1);
    expect((await list('is_test=true&device=garmin')).total).toBe(0);
    expect((await list('is_test=true&kind=sleep')).total).toBe(0);
    // Luna and Polar are compared in it, so it shows under "comparable" and not under its opposite.
    expect((await list('is_test=true&comparable=true')).total).toBe(1);
    expect((await list('is_test=true&comparable=false')).total).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/benchmarks?comparable=maybe', headers: admin })).statusCode).toBe(422);
    expect((await list('is_test=false')).total).toBe(0);
  });

  it('re-tags a device, which changes who is tested against whom, and remembers the tag', async () => {
    const before = await get(ref);
    const luna = before.recordings[0];
    const patched = await app.inject({ method: 'PATCH', url: `/v1/admin/benchmarks/${ref}/recordings/${luna.id}`, headers: as('qc'), payload: { device_tag: 'garmin', device_label: 'Forerunner 265' } });
    expect(patched.statusCode).toBe(200);
    const s = patched.json();
    expect(s.devices).toEqual(['garmin', 'phone', 'polar']);
    // No Luna any more: the Garmin is measured against the Polar strap.
    expect(s.summary.pairs[0]).toMatchObject({ test: luna.id });
    expect(s.summary.headline).toMatchObject({ test: 'garmin', reference: 'polar' });
    expect(s.recordings.find((x: { id: string }) => x.id === luna.id)).toMatchObject({ device_label: 'Forerunner 265', tag_label: 'Garmin' });

    // The same source in a later session takes the corrected tag rather than the guess.
    const later = T0 + 100_000;
    const r = await post(body(later, [lunaRec(later)]));
    expect(r.statusCode).toBe(201);
    expect((await get(r.json().session.ref)).recordings[0]).toMatchObject({ device_tag: 'garmin', device_label: 'Forerunner 265' });

    await app.inject({ method: 'PATCH', url: `/v1/admin/benchmarks/${ref}/recordings/${luna.id}`, headers: as('qc'), payload: { device_tag: 'luna', device_label: null } });
    expect((await get(ref)).summary.headline).toMatchObject({ test: 'luna', reference: 'polar' });
  });

  it('edits title, notes and the test flag', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/v1/admin/benchmarks/${ref}`, headers: as('qc'), payload: { title: 'Tempo run, band on left wrist', notes: 'fw 1.2.3', is_test: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ title: 'Tempo run, band on left wrist', notes: 'fw 1.2.3' });
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/benchmarks/${ref}`, headers: as('qc'), payload: {} })).statusCode).toBe(422);
  });

  it('removes one device and redoes the comparison; the last logging device takes the session with it', async () => {
    const s = await get(ref);
    const luna = s.recordings.find((x: { device_tag: string }) => x.device_tag === 'luna');
    const r = await app.inject({ method: 'DELETE', url: `/v1/admin/benchmarks/${ref}/recordings/${luna.id}`, headers: as('qc') });
    expect(r.json().session).toMatchObject({ devices: ['phone', 'polar'], summary: { pairs: [] } });
    const polar = r.json().session.recordings.find((x: { device_tag: string }) => x.device_tag === 'polar');
    const last = await app.inject({ method: 'DELETE', url: `/v1/admin/benchmarks/${ref}/recordings/${polar.id}`, headers: as('qc') });
    expect(last.json()).toMatchObject({ deleted: ref, session: null });
    expect((await app.inject({ method: 'GET', url: `/v1/admin/benchmarks/${ref}`, headers: admin })).statusCode).toBe(404);
  });
});

describe('a distance entered by hand for Luna', () => {
  it('stands in for the distance Luna did not write, gives pace and speed, and can be cleared', async () => {
    const t = T0 + 200_000;
    const bare = { ...lunaRec(t), workout: { ...workout(t + 10, t + 1190, 0, 110), stats: [{ type: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal', sum: 110 }] } };
    const ref = (await post(body(t, [polarRec(t), bare]))).json().session.ref;
    const before = await get(ref);
    const luna = before.recordings.find((x: { source_name: string }) => x.source_name === LUNA);
    const polar = before.recordings.find((x: { source_name: string }) => x.source_name === POLAR);
    expect(luna.metrics.distance).toBeUndefined();
    const url = `/v1/admin/benchmarks/${ref}/recordings/${luna.id}`;

    // The source took the Garmin tag an earlier session left it with; tagging it Luna in the same change is enough.
    const r = await app.inject({ method: 'PATCH', url, headers: as('qc'), payload: { device_tag: 'luna', distance_km: 2.9 } });
    expect(r.statusCode).toBe(200);
    const after = r.json().recordings.find((x: { id: string }) => x.id === luna.id);
    expect(after.metrics.distance).toMatchObject({ value: 2.9, from: 'manual' });
    expect(after.metrics.pace).toMatchObject({ value: Math.round(1180 / 2.9), from: 'derived' });
    expect(after.metrics.speed).toBeDefined();
    expect(after.details.manual).toMatchObject({ distance_km: 2.9, by: email('qc') });
    const row = r.json().summary.pairs[0].rows.find((x: { key: string }) => x.key === 'distance');
    expect(row).toMatchObject({ reference: 3, test: 2.9 });
    expect(row.note).toContain('entered by hand');

    // Only for a workout Luna logged, only by a role that may change benchmarks, and only a real distance.
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/benchmarks/${ref}/recordings/${polar.id}`, headers: as('qc'), payload: { distance_km: 3 } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url, headers: as('biz'), payload: { distance_km: 3 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, headers: as('qc'), payload: { distance_km: -1 } })).statusCode).toBe(422);

    const cleared = (await app.inject({ method: 'PATCH', url, headers: as('qc'), payload: { distance_km: null } })).json().recordings.find((x: { id: string }) => x.id === luna.id);
    expect(cleared.metrics.distance).toBeUndefined();
    expect(cleared.metrics.pace).toBeUndefined();
    expect(cleared.details.manual).toBeUndefined();
  });
});

describe('a night', () => {
  const V = 'HKCategoryValueSleepAnalysis';
  const N = T0 + 300_000, H = 3600;
  const night = (source: string, segments: [number, number, string][]) => ({ source, logged: true, samples: {}, sleep: { start: Math.min(...segments.map((s) => s[0])), end: Math.max(...segments.map((s) => s[1])), segments } });

  it('stores stages from two devices and compares them', async () => {
    const ring = night(OURA, [[N, N + 1200, V + 'Awake'], [N + 1200, N + 3 * H, V + 'AsleepCore'], [N + 3 * H, N + 4 * H, V + 'AsleepDeep'], [N + 4 * H, N + 7 * H, V + 'AsleepREM']]);
    const luna = night(LIFEOS, [[N + 600, N + 1800, V + 'Awake'], [N + 1800, N + 3 * H, V + 'AsleepCore'], [N + 3 * H, N + 4 * H + 600, V + 'AsleepDeep'], [N + 4 * H + 600, N + 7 * H, V + 'AsleepREM']]);
    const r = await post({ tester: TESTER, kind: 'sleep', start: N, end: N + 7 * H, utc_offset_min: 330, is_test: true, recordings: [ring, luna] });
    expect(r.statusCode).toBe(201);
    const s = await get(r.json().session.ref);
    expect(s).toMatchObject({ kind: 'sleep', activity: null, devices: ['luna', 'oura'] });
    const lunaRow = s.recordings[0];
    expect(lunaRow).toMatchObject({ source_name: LIFEOS, device_tag: 'luna' });
    expect(lunaRow.metrics).toMatchObject({ sleep_latency: { value: 1200 }, total_sleep: { value: 7 * H - 1800 }, deep_sleep: { value: H + 600 } });
    expect(lunaRow.stages.runs[0]).toEqual([0, 1200, 'awake']);
    expect(s.summary.pairs[0]).toMatchObject({ test: lunaRow.id, sleep: { labels: ['Awake', 'Light', 'Deep', 'REM'] } });
    // Luna fell asleep 10 minutes after the ring says, and held deep sleep 10 minutes longer.
    expect(s.summary.pairs[0].rows.find((x: { key: string }) => x.key === 'sleep_latency')).toMatchObject({ reference: 1200, test: 1200, verdict: 'match' });
    expect(s.summary.pairs[0].rows.find((x: { key: string }) => x.key === 'total_sleep')).toMatchObject({ diff: -600, verdict: 'match' });
    expect(s.summary.pairs[0].sleep.sleep_wake_pct).toBeGreaterThan(95);
  });
});

describe('one workout recorded as two sessions', () => {
  // Fitbit logs a walk; the band logs the same walk with a clock 12 minutes out, so the two do not overlap.
  const FIT = `Fitbit ${run}`, BAND = `LifeOS band ${run}`;
  const W = T0 + 900_000;
  const walk = (start: number, end: number) => ({ activity: 'HKWorkoutActivityTypeWalking', start, end, duration: (end - start) / 60, duration_unit: 'min', stats: [], metadata: {}, events: [] });
  const hr30 = (start: number, n: number) => ({ unit: 'count/min', t0: start, s: Array.from({ length: n }, (_, i) => i * 30), e: Array.from({ length: n }, (_, i) => i * 30 + 30), v: Array.from({ length: n }, (_, i) => 100 + (i % 7)) });
  let fitRef = '', bandRef = '';

  it('imports them as two sessions and offers each to the other', async () => {
    const a = await post({ ...body(W, [
      { source: FIT, logged: true, samples: {}, workout: walk(W, W + 641) },
      { source: BAND, logged: false, samples: { HKQuantityTypeIdentifierHeartRate: hr30(W, 21) } },
      phoneRec(W),
    ]), end: W + 641 });
    const b = await post({ ...body(W + 729, [
      { source: BAND, logged: true, samples: { HKQuantityTypeIdentifierHeartRate: hr30(W + 729, 22) }, workout: walk(W + 729, W + 1389) },
      phoneRec(W + 729),
    ]), end: W + 1389 });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    fitRef = a.json().session.ref; bandRef = b.json().session.ref;
    expect(bandRef).not.toBe(fitRef);

    const fit = await get(fitRef);
    expect(fit.summary).toMatchObject({ pairs: [], why: 'Luna did not log this workout; Fitbit has no heart rate for it' });
    // One device logged each, so neither is comparable until they are merged.
    const lone = (await app.inject({ method: 'GET', url: `/v1/admin/benchmarks?tester=${encodeURIComponent(TESTER)}&is_test=true&comparable=false`, headers: admin })).json();
    expect(lone.items.map((x: { ref: string }) => x.ref)).toEqual(expect.arrayContaining([fitRef, bandRef]));
    expect(fit.nearby).toHaveLength(1);
    expect(fit.nearby[0]).toMatchObject({ ref: bandRef, starts_after_s: 729, likely_same: true, devices: [{ label: BAND, tag: 'luna', logged: true }, { tag: 'phone', logged: false }] });
    expect((await get(bandRef)).nearby[0]).toMatchObject({ ref: fitRef, starts_after_s: -729, likely_same: true });
  });

  it('does not offer a session where the same device logged another workout', async () => {
    // The band logs a second walk straight after: next to the first band session, but not the same one.
    const later = await post({ ...body(W + 1500, [{ source: BAND, logged: true, samples: {}, workout: walk(W + 1500, W + 2100) }]), end: W + 2100 });
    const laterRef = later.json().session.ref;
    expect((await get(bandRef)).nearby.map((n: { ref: string }) => n.ref)).toEqual([fitRef]);
    const refused = await app.inject({ method: 'POST', url: `/v1/admin/benchmarks/${bandRef}/merge`, headers: as('qc'), payload: { other: laterRef } });
    expect(refused.statusCode).toBe(409);
    await app.inject({ method: 'DELETE', url: `/v1/admin/benchmarks/${laterRef}`, headers: admin });
  });

  it('lists the pair in the one-time pass without changing anything', async () => {
    const service = new BenchmarksService(new BenchmarksRepo(app.db));
    const pairs = (await service.mergeLikelySame(false)).filter((p) => p.into === fitRef || p.from === fitRef);
    expect(pairs).toEqual([{ into: fitRef, from: bandRef, starts_after_s: 729, devices: [BAND] }]);
    expect((await get(bandRef)).ref).toBe(bandRef);
  });

  it('merges them: the band’s own recording replaces its background samples, and the two are compared', async () => {
    expect((await app.inject({ method: 'POST', url: `/v1/admin/benchmarks/${fitRef}/merge`, headers: as('biz'), payload: { other: bandRef } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/benchmarks/${fitRef}/merge`, headers: as('qc'), payload: { other: fitRef } })).statusCode).toBe(422);
    const r = await app.inject({ method: 'POST', url: `/v1/admin/benchmarks/${fitRef}/merge`, headers: as('qc'), payload: { other: bandRef } });
    expect(r.statusCode).toBe(200);
    const s = r.json().session;
    expect(r.json().merged).toBe(bandRef);
    expect(s).toMatchObject({ ref: fitRef, devices: ['fitbit', 'luna', 'phone'], duration_s: 1389, nearby: [] });
    expect(s.recordings.map((x: { source_name: string; logged: boolean }) => [x.source_name, x.logged])).toEqual([[BAND, true], [FIT, true], [PHONE, false]]);
    // The band's heart rate from both sessions, each reading once.
    expect(s.recordings[0].series.heart_rate.v).toHaveLength(43);
    expect(s.recordings[2].series.steps.v).toHaveLength(4);
    const pair = s.summary.pairs[0];
    expect(pair).toMatchObject({ test: s.recordings[0].id, reference: s.recordings[1].id, hr: null });
    expect(pair.rows.find((x: { key: string }) => x.key === 'start')).toMatchObject({ diff: 729, verdict: 'differs' });
    expect(s.summary.gaps[0]).toContain('starts 12 min after');
    expect((await app.inject({ method: 'GET', url: `/v1/admin/benchmarks/${bandRef}`, headers: admin })).statusCode).toBe(404);
  });

  it('still recognises both recordings when the export is uploaded again', async () => {
    const candidates = [
      { key: 'f', kind: 'workout', source: FIT, start: W, end: W + 641 },
      { key: 'b', kind: 'workout', source: BAND, start: W + 729, end: W + 1389 },
    ];
    const check = (await app.inject({ method: 'POST', url: '/v1/admin/benchmarks/check', headers: admin, payload: { tester: TESTER, candidates } })).json();
    expect(check.groups.map((g: { status: string; session: { ref: string } }) => [g.status, g.session.ref])).toEqual([['imported', fitRef], ['imported', fitRef]]);
  });
});

describe('who may do what', () => {
  it('lets every signed-in role read, and only QC, developers and admins change', async () => {
    const r = await post(body(T0 + 600_000, [polarRec(T0 + 600_000)]), as('biz'));
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/benchmarks/check', headers: as('biz'), payload: { tester: TESTER, candidates: [{ key: 'a', kind: 'workout', source: POLAR, start: T0, end: T0 + 1 }] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/benchmarks', headers: as('biz') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/benchmarks/device-tags', headers: as('biz') })).json().items[0]).toEqual({ tag: 'luna', label: 'Luna' });
  });

  it('keeps testers’ health data away from the app key and from anyone not signed in', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/admin/benchmarks', headers: appKey })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/benchmarks', headers: dash })).statusCode).toBe(401);
  });

  it('serves the pages and the export reader without a session: they hold no data', async () => {
    for (const url of ['/dashboard/benchmarks', '/dashboard/benchmarks/BM-0001']) {
      const page = await app.inject({ method: 'GET', url });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
    }
    const script = await app.inject({ method: 'GET', url: '/dashboard/assets/health-export.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.body).toContain('export async function scanExport');
    expect((await app.inject({ method: 'GET', url: '/dashboard/assets/nope.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/b/BM-0001' })).headers.location).toBe('/dashboard/benchmarks/BM-0001');
  });
});

describe('screenshots on a session', () => {
  it('attaches up to six, shows them on the session, and deletes the files with it', async () => {
    const { ImageKitClient } = await import('../../src/modules/uploads/imagekit.js');
    const deleted: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => { if (init?.method === 'DELETE') deleted.push(String(input).split('/').pop()!); return new Response('', { status: 204 }); };
    const ik = new ImageKitClient({ publicKey: 'public_test_key', privateKey: 'private_test_key', urlEndpoint: 'https://ik.imagekit.io/testacct', folder: '/luna-feedback-screenshots', fetchImpl: fakeFetch });
    const app2 = buildApp({ config: cfg, logger: false, db: app.db, jira: null, diagnosis: { logs: null, ai: null }, imagekit: ik });
    await app2.ready();
    const shot = (n: string) => ({ file_id: n, url: `https://ik.imagekit.io/testacct/luna-feedback-screenshots/benchmarks/${n}.jpg`, name: `${n}.png`, width: 739, height: 1600, size: 74_000 });
    const add = (ref: string, payload: unknown, headers: Record<string, string> = as('qc')) => app2.inject({ method: 'POST', url: `/v1/admin/benchmarks/${ref}/screenshots`, headers, payload: payload as object });

    const auth = await app2.inject({ method: 'GET', url: '/v1/admin/benchmarks/screenshot-auth', headers: as('qc') });
    expect(auth.statusCode).toBe(200);
    expect(auth.json()).toMatchObject({ public_key: 'public_test_key', folder: '/luna-feedback-screenshots/benchmarks', max_count: 6 });
    expect(auth.json().signature).toMatch(/^[0-9a-f]{40}$/);
    expect((await app2.inject({ method: 'GET', url: '/v1/admin/benchmarks/screenshot-auth', headers: as('biz') })).statusCode).toBe(403);

    const t = T0 + 900_000;
    const ref = (await post(body(t, [polarRec(t), lunaRec(t)]))).json().session.ref;
    expect((await get(ref)).screenshots).toEqual([]);

    const first = await add(ref, shot('bm_a'));
    expect(first.statusCode).toBe(201);
    expect(first.json().screenshots).toEqual([{ ...shot('bm_a'), added_by: email('qc'), added_at: expect.any(String) }]);
    // The same file twice is one screenshot.
    expect((await add(ref, shot('bm_a'))).json().screenshots).toHaveLength(1);
    expect((await add(ref, shot('bm_x'), as('biz'))).statusCode).toBe(403);
    expect((await add(ref, { file_id: 'bm_evil', url: 'https://evil.example.com/x.png' })).statusCode).toBe(422);
    expect((await add('BM-99999999', shot('bm_a'))).statusCode).toBe(404);

    for (const n of ['bm_b', 'bm_c', 'bm_d', 'bm_e', 'bm_f']) expect((await add(ref, shot(n))).statusCode).toBe(201);
    const seventh = await add(ref, shot('bm_g'));
    expect(seventh.statusCode).toBe(409);
    expect((await get(ref)).screenshots.map((s: { file_id: string }) => s.file_id)).toEqual(['bm_a', 'bm_b', 'bm_c', 'bm_d', 'bm_e', 'bm_f']);

    const gone = await app2.inject({ method: 'DELETE', url: `/v1/admin/benchmarks/${ref}/screenshots/bm_c`, headers: as('qc') });
    expect(gone.statusCode).toBe(200);
    expect(gone.json().screenshots.map((s: { file_id: string }) => s.file_id)).toEqual(['bm_a', 'bm_b', 'bm_d', 'bm_e', 'bm_f']);
    expect(deleted).toEqual(['bm_c']);
    expect((await app2.inject({ method: 'DELETE', url: `/v1/admin/benchmarks/${ref}/screenshots/bm_c`, headers: as('qc') })).statusCode).toBe(404);

    expect((await app2.inject({ method: 'DELETE', url: `/v1/admin/benchmarks/${ref}`, headers: admin })).statusCode).toBe(200);
    expect(deleted.sort()).toEqual(['bm_a', 'bm_b', 'bm_c', 'bm_d', 'bm_e', 'bm_f']);
    await app2.close();
  });
});

describe('what is refused', () => {
  it('rejects a session with no device that logged it, mismatched columns and oversized input', async () => {
    const none = await post(body(T0 + 700_000, [phoneRec(T0 + 700_000)]));
    expect(none.statusCode).toBe(422);
    const bad = polarRec(T0 + 700_000);
    bad.samples.HKQuantityTypeIdentifierHeartRate.v.pop();
    expect((await post(body(T0 + 700_000, [bad]))).statusCode).toBe(422);
    expect((await post(body(T0 + 700_000, [polarRec(T0 + 700_000)], { tester: '' }))).statusCode).toBe(422);
    expect((await post(body(T0 + 700_000, [polarRec(T0 + 700_000)], { extra: true }))).statusCode).toBe(422);
  });

  it('drops an implausible body profile instead of refusing the session', async () => {
    const t = T0 + 800_000;
    const r = await post(body(t, [{ ...polarRec(t), profile: { weight_kg: 66, height_cm: 7407 } }]));
    expect(r.statusCode).toBe(201);
    expect((await get(r.json().session.ref)).recordings[0].details.profile).toEqual({ weight_kg: 66 });
  });

  it('answers 404 for a session that is not there', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/admin/benchmarks/BM-99999999', headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/benchmarks/BM-99999999', headers: admin })).statusCode).toBe(404);
  });
});
