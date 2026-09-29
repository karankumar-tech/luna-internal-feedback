import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';

/**
 * The home page's endpoints: the one-request overview (counts today and over 7 days, the category
 * graph, labels, badge counts, the first page of issues) and the paginated, filterable list.
 * The top numbers only count real reports, so some reports here are real; all are removed afterwards.
 */
const DOMAIN = 'luna-home-test.invalid';
const run = `${Date.now()}`;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', CX_API_KEY: `cx_home_key_${run}` });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const cxHeaders = { 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

let n = 0;
const report = async (over: Record<string, unknown> = {}, feature = 'activity') => {
  n += 1;
  const res = await app.inject({
    method: 'POST', url: `/v1/feedback/${feature}`, headers: appHeaders,
    payload: {
      is_test: true, is_positive: false, occurred_on: '2026-06-01', user_id: 900700 + n, email: `r${n}+${run}@${DOMAIN}`,
      issue_categories: ['incorrect_training_load'], feedback_text: `home test ${n} ${run}`, client: { environment: 'uat' }, ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; ref: string };
};
const home = async (headers: Record<string, string> = adminHeaders) => (await app.inject({ method: 'GET', url: '/v1/home', headers })).json();
const reports = async (q: string, headers: Record<string, string> = adminHeaders) => {
  const res = await app.inject({ method: 'GET', url: `/v1/home/reports?${q}`, headers });
  return { status: res.statusCode, body: res.json() };
};

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1 or cx_ref like $2`, [`%@${DOMAIN}`, `zz-home-${run}%`]);
  await app.db.query(`delete from luna_feedback.issue_kinds where key like $1`, [`zz_home_${run}%`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('GET /v1/home', () => {
  it('counts real issues received today and over 7 days, by category, and ignores test data and working-fine reports', async () => {
    const before = await home();
    await report({ is_test: false });
    await app.inject({
      method: 'POST', url: '/v1/cx/feedback/activity', headers: cxHeaders,
      payload: { is_test: false, is_positive: false, occurred_on: '2026-06-01', device_serial: `R2NHOM${run.slice(-6)}`, issue_categories: ['incorrect_training_load'], feedback_text: 'customer: training load wrong', cx: { ref: `zz-home-${run}-1` } },
    });
    await report({ is_test: true });
    await report({ is_test: false, is_positive: true, issue_categories: undefined });

    const after = await home();
    expect(after.summary.today.issues - before.summary.today.issues).toBe(2);
    expect(after.summary.today.cx - before.summary.today.cx).toBe(1);
    expect(after.summary.last_7_days.issues - before.summary.last_7_days.issues).toBe(2);
    const bar = (h: { categories: { feature_key: string; key: string; count: number; cx: number }[] }) =>
      h.categories.find((c) => c.feature_key === 'activity' && c.key === 'incorrect_training_load') ?? { count: 0, cx: 0 };
    expect(bar(after).count - bar(before).count).toBe(2);
    expect(bar(after).cx - bar(before).cx).toBe(1);
  });

  it('carries labels, badge counts, who is looking, and the first page of real issues', async () => {
    const h = await home();
    expect(h.labels.features.activity).toBeTruthy();
    expect(h.labels.categories.activity.incorrect_training_load).toMatch(/training load/i);
    expect(h.counts).toEqual(expect.objectContaining({ mine: expect.any(Number), untouched: expect.any(Number), stale: expect.any(Number) }));
    expect(h.viewer).toMatchObject({ role: 'admin', permissions: expect.objectContaining({ manage_triage: true }) });
    expect(h.reports).toMatchObject({ page: 1, page_size: 25 });
    expect(h.reports.items.every((r: { is_test: boolean; is_positive: boolean }) => !r.is_test && !r.is_positive)).toBe(true);
    // Lean: no transcript, screenshots or details on list items.
    const item = h.reports.items[0];
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('cx_transcript');
    expect(item).not.toHaveProperty('details');
  });
});

describe('GET /v1/home/reports', () => {
  it('pages through test issues with a total, newest first', async () => {
    for (let i = 0; i < 6; i++) await report({ feedback_text: `page item ${i} ${run}` });
    const p1 = await reports('data=test&page_size=5&page=1');
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(5);
    expect(p1.body.total).toBeGreaterThanOrEqual(6);
    const p2 = await reports('data=test&page_size=5&page=2');
    expect(p2.body.items[0].ref).not.toBe(p1.body.items[0].ref);
    const times = p1.body.items.map((r: { created_at: string }) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    const past = await reports('data=test&page_size=5&page=999');
    expect(past.body).toMatchObject({ items: [], total: p1.body.total, page: 999 });
  });

  it('splits issues from working-fine reports and real from test', async () => {
    const fine = await reports('view=fine&data=all&page_size=100');
    expect(fine.body.items.every((r: { is_positive: boolean }) => r.is_positive)).toBe(true);
    const test = await reports('data=test&page_size=100');
    expect(test.body.items.every((r: { is_test: boolean; is_positive: boolean }) => r.is_test && !r.is_positive)).toBe(true);
    const all = await reports('view=all&data=all&page_size=5');
    expect(all.body.total).toBeGreaterThanOrEqual(fine.body.total + test.body.total);
  });

  it('narrows to a category received in the last 7 days, as the graph does', async () => {
    const r = await reports('data=all&feature=activity&category=incorrect_training_load&received=7d&page_size=100');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((x: { feature_key: string; issue_categories: string[] }) => x.feature_key === 'activity' && x.issue_categories.includes('incorrect_training_load'))).toBe(true);
  });

  it('puts each report\'s problem, with its size, on the item', async () => {
    const a = await report({ is_test: false, feedback_text: `grouped one ${run}` });
    const b = await report({ is_test: false, feedback_text: `grouped two ${run}` });
    const kind = (await app.inject({ method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { key: `zz_home_${run}_load`, title: `Training load jumps ${run}` } })).json();
    for (const s of [a, b]) await app.inject({ method: 'POST', url: `/v1/admin/submissions/${s.id}/kinds`, headers: adminHeaders, payload: { kind_id: kind.id } });
    const r = await reports(`data=real&kind_id=${kind.id}`);
    expect(r.body.total).toBe(2);
    expect(r.body.items[0].kinds).toEqual([{ id: kind.id, ref: kind.ref, title: kind.title, reports: 2 }]);
  });

  it('"assigned to me" lists the signed-in person\'s open issues, with their name as owner', async () => {
    const email = `owner+${run}@${DOMAIN}`;
    const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email, role: 'qc', name: 'Owner Person' } })).json().generated_password;
    const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email, password: pass } });
    const me = { ...dash, cookie: String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '' };
    const open = await report();
    const done = await report();
    for (const s of [open, done]) await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${s.id}`, headers: adminHeaders, payload: { assigned_to: email } });
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${done.id}`, headers: adminHeaders, payload: { status: 'resolved' } });

    const r = await reports('view=mine&data=test', me);
    expect(r.body.items.map((x: { ref: string }) => x.ref)).toEqual([open.ref]);
    expect(r.body.items[0]).toMatchObject({ assigned_to: email, owner_name: 'Owner Person' });
    const withStatus = await reports('view=mine&data=test&status=resolved', me);
    expect(withStatus.body.items.map((x: { ref: string }) => x.ref)).toEqual([done.ref]);
  });

  it('rejects bad paging and backwards date ranges', async () => {
    expect((await reports('page_size=2')).status).toBe(422);
    expect((await reports('page=0')).status).toBe(422);
    expect((await reports('from=2026-06-10&to=2026-06-01')).status).toBe(422);
    expect((await reports('view=nope')).status).toBe(422);
  });
});

describe('pages', () => {
  it('serves the settings page, and lets the edge keep pages', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Report categories');
    const dash = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dash.headers['cdn-cache-control']).toMatch(/s-maxage/);
    expect(dash.headers['cache-control']).toMatch(/must-revalidate/);
  });
});
