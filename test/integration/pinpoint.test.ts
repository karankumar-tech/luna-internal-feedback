import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { todayInZone } from '../../src/lib/time.js';

/**
 * Pinpointing: fix versions and regressions, where a problem happens, spikes, repeat rings, and
 * whether testing caught a problem before customers did. Regressions only count real reports, so
 * those tests file real (UAT) reports; everything is removed afterwards.
 */
const DOMAIN = 'luna-pinpoint-test.invalid';
const run = `${Date.now()}`;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', CX_API_KEY: `cx_pinpoint_key_${run}` });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const cxHeaders = { 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' };

const today = todayInZone(cfg.APP_TIMEZONE);
const daysAgo = (n: number) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

let n = 0;
interface Filed { id: string; ref: string }
const report = async (over: Record<string, unknown> = {}, feature = 'workout') => {
  n += 1;
  const res = await app.inject({
    method: 'POST', url: `/v1/feedback/${feature}`, headers: appHeaders,
    payload: {
      is_test: true, is_positive: false, occurred_on: '2026-06-01', user_id: 900500 + n, email: `r${n}+${run}@${DOMAIN}`,
      issue_categories: ['incorrect_duration'], feedback_text: `pinpoint test ${n} ${run}`, ...over,
      client: { environment: 'uat', platform: 'ios', ...(over.client as object | undefined) },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Filed;
};
const cxReport = async (serial: string, over: Record<string, unknown> = {}, feature = 'workout') => {
  n += 1;
  const res = await app.inject({
    method: 'POST', url: `/v1/cx/feedback/${feature}`, headers: cxHeaders,
    payload: { is_test: true, is_positive: false, occurred_on: '2026-06-01', device_serial: serial, issue_categories: ['incorrect_duration'], feedback_text: `customer report ${n}`, cx: { ref: `zz-pin-${run}-${n}` }, ...over },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Filed;
};
const kind = async (slug: string, title: string) => (await app.inject({
  method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { key: `zz_pin_${run}_${slug}`, title: `${title} ${run}` },
})).json() as { id: string; ref: string };
const link = async (sub: Filed, k: { id: string }) => {
  const res = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${sub.id}/kinds`, headers: adminHeaders, payload: { kind_id: k.id } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as { kind_id: string; regression: boolean }[];
};
const patchKind = (k: { id: string }, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/v1/admin/kinds/${k.id}`, headers: adminHeaders, payload });
const detail = async (k: { id: string }, q = '') => (await app.inject({ method: 'GET', url: `/v1/kinds/${k.id}?${q}`, headers: appHeaders })).json();
const history = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}/activity`, headers: appHeaders })).json().items as { action: string; actor: string; to_value: string; note: string }[];
const attention = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/attention?${q}`, headers: adminHeaders })).json();

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1 or cx_ref like $2`, [`%@${DOMAIN}`, `zz-pin-${run}%`]);
  await app.db.query(`delete from luna_feedback.issue_kinds where key like $1`, [`zz_pin_${run}%`]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('fix versions and regressions', () => {
  it('flags a report on the fix version or later, reopens the problem, and says why on the report', async () => {
    const k = await kind('back', 'Workout loses minutes');
    const real = (app_version: string | null) => report({ is_test: false, client: app_version ? { app_version } : {} });
    await link(await real('2.3.0'), k);

    expect((await patchKind(k, { fixed_in_app_version: 'dev' })).statusCode).toBe(422);
    const fixed = await patchKind(k, { status: 'fixed', fixed_in_app_version: '2.4.0' });
    expect(fixed.json()).toMatchObject({ status: 'fixed', fixed_in_app_version: '2.4.0', fixed_in_firmware_version: null });

    // Older than the fix: an old install, not a regression.
    const older = await real('2.3.9');
    expect((await link(older, k)).find((l) => l.kind_id === k.id)!.regression).toBe(false);
    expect((await detail(k)).status).toBe('fixed');

    // 2.10.0 is newer than 2.4.0: the fix did not hold.
    const back = await real('2.10.0');
    expect((await link(back, k)).find((l) => l.kind_id === k.id)!.regression).toBe(true);
    const d = await detail(k);
    expect(d.status).toBe('watching');
    expect(d.regressed_at).toMatch(/^\d{4}-/);
    expect(d.regressions.map((r: { ref: string }) => r.ref)).toEqual([back.ref]);
    const ev = (await history(back.id)).find((e) => e.action === 'regression')!;
    expect(ev).toMatchObject({ actor: 'rule', to_value: k.ref });
    expect(ev.note).toContain('app 2.10.0 (fixed in 2.4.0)');
    expect(ev.note).toContain('reopened as watching');

    // Getting worse on the attention page, for real data.
    const a = await attention('is_test=false');
    expect(a.growing.regressions.map((r: { ref: string }) => r.ref)).toContain(k.ref);
    expect(a.counts.growing).toBeGreaterThanOrEqual(1);
    expect((await attention('is_test=true')).growing.regressions).toEqual([]);

    // Linking the same report again changes nothing.
    await link(back, k);
    expect((await history(back.id)).filter((e) => e.action === 'regression')).toHaveLength(1);

    // Test data and reports without a version are never flagged.
    const test = await report({ client: { app_version: '9.0.0' } });
    expect((await link(test, k)).find((l) => l.kind_id === k.id)!.regression).toBe(false);
    const unknown = await real(null);
    expect((await link(unknown, k)).find((l) => l.kind_id === k.id)!.regression).toBe(false);

    // Marked fixed again: off the attention page.
    await patchKind(k, { status: 'fixed', fixed_in_app_version: '2.11.0' });
    expect((await attention('is_test=false')).growing.regressions.map((r: { ref: string }) => r.ref)).not.toContain(k.ref);
  });

  it('with a firmware fix too, needs both versions met', async () => {
    const k = await kind('both', 'Heart rate drops out');
    await patchKind(k, { status: 'fixed', fixed_in_app_version: '2.4.0', fixed_in_firmware_version: '1.9.4' });
    const oldRing = await report({ is_test: false, client: { app_version: '2.5.0', firmware_version: '1.9.3' } });
    expect((await link(oldRing, k)).find((l) => l.kind_id === k.id)!.regression).toBe(false);
    const both = await report({ is_test: false, client: { app_version: '2.5.0', firmware_version: '1.10.0' } });
    expect((await link(both, k)).find((l) => l.kind_id === k.id)!.regression).toBe(true);
  });
});

describe('where it happens', () => {
  it('compares the problem with all reports in the slice, and finds the oldest versions', async () => {
    const k = await kind('skew', 'Zones wrong on new firmware');
    const on = (fw: string, extra: Record<string, unknown> = {}) => report({ occurred_on: '2025-11-11', client: { firmware_version: fw, app_version: '2.4.0' }, ...extra });
    for (let i = 0; i < 4; i++) await link(await on('9.9.1'), k);
    await link(await on('9.9.0'), k);
    for (let i = 0; i < 6; i++) await on('9.8.0', { client: { firmware_version: '9.8.0', platform: 'android', app_version: '1.8.0' } });

    const d = await detail(k, 'from=2025-11-11&to=2025-11-11&is_test=true&environment=uat');
    expect(d.count).toBe(5);
    const fw = d.skew.dims.find((x: { dim: string }) => x.dim === 'firmware');
    expect(fw).toMatchObject({ kind_known: 5, base_known: 11 });
    expect(fw.values[0]).toMatchObject({ value: '9.9.1', kind_count: 4, base_count: 4, kind_share: 0.8, base_share: 0.36, notable: true });
    expect(d.skew.headline).toMatchObject({ value: '9.9.1' });
    expect(['firmware', 'app', 'platform', 'os']).toContain(d.skew.headline.dim);
    const app2 = d.skew.dims.find((x: { dim: string }) => x.dim === 'app');
    expect(app2.values[0]).toMatchObject({ value: 'ios 2.4.0', kind_count: 5 });
    expect(d.oldest_versions).toEqual({ firmware: '9.9.0', app: [{ platform: 'ios', version: '2.4.0' }] });
  });
});

describe('spikes', () => {
  it('flags a problem and a category at 3× their usual rate, and not a steady one', async () => {
    const q = 'is_test=true&environment=uat&feature=activity';
    const spiking = await kind('spike', 'Training load jumps');
    for (const d of [0, 1, 2]) await link(await report({ occurred_on: daysAgo(d), issue_categories: ['incorrect_training_load'] }, 'activity'), spiking);

    const steady = await kind('steady', 'Steps a little low');
    for (let d = 0; d < 17; d++) await link(await report({ occurred_on: daysAgo(d), issue_categories: ['incorrect_steps'] }, 'activity'), steady);

    const rising = await kind('rising', 'Calories doubled');
    for (const d of [0, 1, 2, 9, 12]) await link(await report({ occurred_on: daysAgo(d), issue_categories: ['incorrect_active_calories'] }, 'activity'), rising);

    const g = (await attention(q)).growing;
    const byRef = new Map(g.kind_spikes.map((r: { ref: string }) => [r.ref, r]));
    expect(byRef.get(spiking.ref)).toMatchObject({ recent: 3, prior: 0, is_new: true, ratio: null });
    expect(byRef.get(rising.ref)).toMatchObject({ recent: 3, prior: 2, is_new: false, ratio: 7 });
    expect(byRef.has(steady.ref)).toBe(false);

    const cats = g.category_spikes.map((r: { feature_key: string; key: string }) => `${r.feature_key}/${r.key}`);
    expect(cats).toContain('activity/incorrect_training_load');
    expect(cats).not.toContain('activity/incorrect_steps');
    expect(g.category_spikes.find((r: { key: string }) => r.key === 'incorrect_training_load').label).not.toBe('incorrect_training_load');
  });
});

describe('same ring, many reports', () => {
  it('flags a customer ring with 3 problem reports in 14 days, on the attention page and on the report', async () => {
    const serial = `R2NPIN${run.slice(-6)}`;
    await cxReport(serial, { occurred_on: daysAgo(10) });
    await cxReport(serial, { occurred_on: daysAgo(4), issue_categories: ['incorrect_sleep'] }, 'sleep');
    const third = await cxReport(serial, { occurred_on: daysAgo(1) });
    const quiet = await cxReport(`R2NQUI${run.slice(-6)}`, { occurred_on: daysAgo(1) });

    const rows = (await attention('is_test=true&origin=cx')).repeat_devices as { device_serial: string; reports: number; cx_reports: number; features: number; items: { ref: string }[] }[];
    const ring = rows.find((r) => r.device_serial === serial)!;
    expect(ring).toMatchObject({ reports: 3, cx_reports: 3, features: 2 });
    expect(ring.items[0]!.ref).toBe(third.ref);
    expect(rows.some((r) => r.device_serial === `R2NQUI${run.slice(-6)}`)).toBe(false);

    const same = (await app.inject({ method: 'GET', url: `/v1/feedback/${third.id}/same-device`, headers: appHeaders })).json();
    expect(same).toMatchObject({ by: 'ring', count: 3, flagged: true, window_days: 14 });
    const alone = (await app.inject({ method: 'GET', url: `/v1/feedback/${quiet.id}/same-device`, headers: appHeaders })).json();
    expect(alone).toMatchObject({ by: 'ring', count: 1, flagged: false });
  });

  it('groups a tester without a serial by their user id', async () => {
    const user_id = 900499;
    let last: Filed | null = null;
    for (const d of [2, 1, 0]) last = await report({ user_id, occurred_on: daysAgo(d) });
    const same = (await app.inject({ method: 'GET', url: `/v1/feedback/${last!.id}/same-device`, headers: appHeaders })).json();
    expect(same).toMatchObject({ by: 'person', count: 3, flagged: true });
  });
});

describe('caught by testing first', () => {
  it('counts problems whose first customer report is in range, and whether testing reported them earlier', async () => {
    const day = '2025-12-12';
    const caught = await kind('caught', 'Pairing drops at night');
    await link(await report({ occurred_on: '2025-12-01' }), caught);
    await link(await cxReport(`R2NCAU${run.slice(-6)}`, { occurred_on: day }), caught);

    const missed = await kind('missed', 'Map never loads');
    await link(await cxReport(`R2NMIS${run.slice(-6)}`, { occurred_on: day }), missed);

    const late = await kind('late', 'Resting HR stuck');
    await link(await cxReport(`R2NLAT${run.slice(-6)}`, { occurred_on: day }), late);
    await link(await report({ occurred_on: day }), late);

    const o = (await app.inject({ method: 'GET', url: `/v1/analytics/overview?is_test=true&from=${day}&to=${day}`, headers: appHeaders })).json();
    const c = o.caught_first;
    expect(c).toMatchObject({ problems: 3, caught: 1, missed: 2 });
    expect(c.lead_p50_days).toBeGreaterThanOrEqual(0);
    const missedRefs = c.missed_items.map((x: { ref: string }) => x.ref);
    expect(missedRefs).toEqual(expect.arrayContaining([missed.ref, late.ref]));
    expect(missedRefs).not.toContain(caught.ref);
    expect(c.missed_items.find((x: { ref: string }) => x.ref === late.ref).first_internal_at).toMatch(/^\d{4}-/);
    expect(c.missed_items.find((x: { ref: string }) => x.ref === missed.ref).first_internal_at).toBeNull();
    expect(c.by_feature.find((x: { feature_key: string }) => x.feature_key === 'workout')).toMatchObject({ problems: 3, caught: 1, missed: 2 });
  });
});
