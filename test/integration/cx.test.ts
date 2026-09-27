import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { LogsClient } from '../../src/modules/diagnosis/logs/client.js';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';

/**
 * CX reports, readable references, the cx role, per-environment log hosts and the attention page.
 * Every row is flagged is_test and removed afterwards: CX rows by their run-specific ticket ref,
 * internal ones by the test email domain.
 */
const DOMAIN = 'luna-test.invalid';
const run = `${Date.now()}`;
const CX_REF = (n: string) => `zz-test-${run}-${n}`;
const PROD_SERIAL = `R2NPROD${run.slice(-6)}`;

// Production and stage logs live on different hosts: only the production fake knows this ring.
const hostCalls: string[] = [];
const logsFetch = (host: 'stage' | 'production'): typeof fetch => async (input) => {
  const url = new URL(String(input));
  hostCalls.push(`${host}:${url.searchParams.get('serial_no') ?? url.searchParams.get('email')}`);
  if (host === 'production' && url.searchParams.get('serial_no') === PROD_SERIAL) {
    return new Response(JSON.stringify({ success: true, data: [{
      user_id: 900777, device_id: 1, platform: 'ios', device_model: 'iPhone15,2', os_version: '19.1',
      fv: '1.9.3', version_name: '2.5.0', batt_perct: 80, updated_at: '2026-09-02T16:00:00.000Z',
      app_logs: '', ring_logs: '', firmware_logs: '',
    }] }), { status: 200 });
  }
  // An empty result comes back wrapped one level deeper than a match does (seen live 2026-09-27).
  return new Response(JSON.stringify({ success: true, data: { success: true, data: [], message: '', time: '1' } }), { status: 200 });
};
const stageLogs = new LogsClient({ baseUrl: 'https://stage.example.invalid', apiKey: 'k', fetchImpl: logsFetch('stage') });
const prodLogs = new LogsClient({ baseUrl: 'https://prod.example.invalid', apiKey: 'k', fetchImpl: logsFetch('production') });
const noModel = new OpenRouterClient({ apiKey: 'k', model: 'm', fetchImpl: async () => { throw new Error('the model must not be called in these tests'); } });

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', CX_API_KEY: `cx_test_key_${run}` });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const cxHeaders = { 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

const internalBody = (over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-09-01', user_id: 900001, email: `cx+${run}@${DOMAIN}`,
  issue_categories: ['incorrect_sleep'], feedback_text: 'internal report', ...over,
});
const cxBody = (ref: string, over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-09-02', device_serial: PROD_SERIAL,
  issue_categories: ['incorrect_sleep'], feedback_text: 'Customer says sleep shows 3h; reach them at jane.doe@example.com',
  cx: { ref, url: 'https://support.example.invalid/tickets/1', channel: 'email', agent: 'Agent Smith', transcript: 'Hi, I am jane.doe@example.com, call me on 9876543210. My sleep is wrong.' },
  ...over,
});

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1 or cx_ref like $2`, [`%@${DOMAIN}`, `zz-test-${run}-%`]);
  await app.db.query(`delete from luna_feedback.issue_kinds where key like $1`, [`zz_test_${run}%`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%+${run}@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%+${run}@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({
    config: cfg, logger: false, jira: null,
    diagnosis: { logs: stageLogs, logsByEnv: { stage: stageLogs, production: prodLogs, uat: null }, ai: noModel },
  });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(100);
  }
}

describe('readable references', () => {
  let ref = '';
  let id = '';

  it('every report gets an LN- reference', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: internalBody() });
    expect(r.statusCode).toBe(201);
    ref = r.json().ref; id = r.json().id;
    expect(ref).toMatch(/^LN-\d{5,}$/);
    expect(r.json().origin).toBe('internal');
    expect(r.json().submitted_via).toBe('app');
  });

  it('finds a report by reference however it is typed', async () => {
    const n = String(Number(ref.slice(3)));
    for (const form of [ref, ref.toLowerCase(), `LN${n}`, n]) {
      const r = await app.inject({ method: 'GET', url: `/v1/feedback/${form}`, headers: appHeaders });
      expect(r.statusCode, form).toBe(200);
      expect(r.json().id).toBe(id);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/LN-99999999', headers: appHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/LNK-1', headers: appHeaders })).statusCode).toBe(404);
  });

  it('filters the list to one reference', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/feedback?ref=${ref.toLowerCase()}&is_test=true`, headers: appHeaders });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((x: { id: string }) => x.id)).toEqual([id]);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback?ref=nonsense', headers: appHeaders })).statusCode).toBe(422);
  });

  it('issue kinds get an LNK- reference and are found by it', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { title: 'Test kind for references', key: `zz_test_${run}_kind` } });
    expect(created.statusCode).toBe(201);
    const kref = created.json().ref;
    expect(kref).toMatch(/^LNK-\d{4,}$/);
    const byRef = await app.inject({ method: 'GET', url: `/v1/kinds/${kref.toLowerCase()}?is_test=true`, headers: adminHeaders });
    expect(byRef.statusCode).toBe(200);
    expect(byRef.json().id).toBe(created.json().id);
    expect(byRef.json()).toMatchObject({ cx_count: 0, cx_users: 0 });

    const link = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/kinds`, headers: adminHeaders, payload: { kind_id: created.json().id } });
    expect(link.json().items[0].ref).toBe(kref);
  });

  it('short links redirect to the report and kind pages', async () => {
    const r = await app.inject({ method: 'GET', url: `/i/${ref}` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/dashboard/submissions/${ref}`);
    const k = await app.inject({ method: 'GET', url: '/k/LNK-0001' });
    expect(k.headers.location).toBe('/dashboard/kinds/LNK-0001');
    // The page itself is public HTML; the data behind it is not.
    expect((await app.inject({ method: 'GET', url: `/dashboard/submissions/${ref}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/dashboard/attention' })).statusCode).toBe(200);
  });
});

describe('CX reports', () => {
  let cx: { id: string; ref: string };

  it('files a customer problem with the CX key: origin cx, no email, production by default', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: cxBody(CX_REF('a')) });
    expect(r.statusCode).toBe(201);
    const view = r.json();
    expect(view.ref).toMatch(/^LN-\d{5,}$/);
    expect(view).toMatchObject({ feature_key: 'sleep', environment: 'production', status: 'open', device_serial: PROD_SERIAL, problems: [] });
    expect(view.cx).toMatchObject({ ref: CX_REF('a'), channel: 'email', agent: 'Agent Smith' });
    expect(view.dashboard_url).toMatch(new RegExp(`/i/${view.ref}$`));
    cx = view;

    const full = (await app.inject({ method: 'GET', url: `/v1/feedback/${view.ref}`, headers: adminHeaders })).json();
    expect(full).toMatchObject({ origin: 'cx', submitted_via: 'cx_tool', email: null, cx_ref: CX_REF('a') });
  });

  it('redacts the customer\'s email and phone from everything it stores', async () => {
    const full = (await app.inject({ method: 'GET', url: `/v1/feedback/${cx.id}`, headers: adminHeaders })).json();
    expect(full.feedback_text).not.toContain('jane.doe@example.com');
    expect(full.feedback_text).toContain('[REDACTED_EMAIL]');
    expect(full.cx_transcript).not.toContain('jane.doe@example.com');
    expect(full.cx_transcript).not.toContain('9876543210');
    expect(JSON.stringify(full)).not.toContain('jane.doe');
  });

  it('fills the Luna user id and device from the production logging host by serial', async () => {
    const filled = await waitFor(async () => {
      const r = (await app.inject({ method: 'GET', url: `/v1/feedback/${cx.id}`, headers: adminHeaders })).json();
      return r.user_id ? r : null;
    });
    expect(filled).toMatchObject({ user_id: 900777, platform: 'ios', firmware_version: '1.9.3', app_version: '2.5.0', os_version: '19.1' });
    expect(hostCalls).toContain(`production:${PROD_SERIAL}`);
    expect(hostCalls).not.toContain(`stage:${PROD_SERIAL}`);
  });

  it('pressing the button twice returns the first report, not a second one', async () => {
    const again = await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: cxBody(CX_REF('a')) });
    expect(again.statusCode).toBe(200);
    expect(again.json().ref).toBe(cx.ref);
    // The same ticket about a different feature is a different report.
    const other = await app.inject({ method: 'POST', url: '/v1/cx/feedback/home', headers: cxHeaders, payload: cxBody(CX_REF('a'), { issue_categories: ['wrong_peak_score'] }) });
    expect(other.statusCode).toBe(201);
    expect(other.json().ref).not.toBe(cx.ref);
  });

  it('refuses a customer email, and requires the serial and the CX ticket', async () => {
    const withEmail = await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: cxBody(CX_REF('b'), { email: 'jane@example.com' }) });
    expect(withEmail.statusCode).toBe(422);
    expect(withEmail.json().error.issues).toContainEqual({ path: 'email', message: expect.stringContaining('never stored') });

    const noSerial = cxBody(CX_REF('c')) as Record<string, unknown>; delete noSerial.device_serial;
    const r1 = await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: noSerial });
    expect(r1.statusCode).toBe(422);
    expect(JSON.stringify(r1.json())).toContain('device_serial');

    const noCx = cxBody(CX_REF('d')) as Record<string, unknown>; delete noCx.cx;
    expect((await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: noCx })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: cxBody(CX_REF('e'), { device_serial: 'R2' }) })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: cxBody(CX_REF('f'), { cx: { ref: CX_REF('f'), channel: 'pigeon' } }) })).statusCode).toBe(422);
  });

  it('keeps each key in its lane', async () => {
    // The app key cannot file CX reports, and a dashboard caller cannot either.
    expect((await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: appHeaders, payload: cxBody(CX_REF('g')) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: dash, payload: cxBody(CX_REF('g')) })).statusCode).toBe(401);
    // The CX key reaches its own routes and the form schema, nothing else.
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: cxHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema/sleep', headers: cxHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback', headers: cxHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: cxHeaders, payload: internalBody() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/features', headers: cxHeaders })).statusCode).toBe(403);
    // Automation with the admin key may file one.
    const byAdmin = await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: adminHeaders, payload: cxBody(CX_REF('h')) });
    expect(byAdmin.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/v1/feedback/${byAdmin.json().id}`, headers: adminHeaders })).json().submitted_via).toBe('admin');
  });

  it('reads back where a CX report stands, but never an internal one', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/cx/feedback/${cx.ref}`, headers: cxHeaders });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ref: cx.ref, status: 'open' });
    expect(r.json().feedback_text).toBeUndefined();

    const internal = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: internalBody({ issue_categories: ['wrong_peak_score'] }) })).json();
    expect((await app.inject({ method: 'GET', url: `/v1/cx/feedback/${internal.ref}`, headers: cxHeaders })).statusCode).toBe(404);
  });

  it('the origin filter and stats agree', async () => {
    const onlyCx = (await app.inject({ method: 'GET', url: '/v1/feedback?origin=cx&is_test=true&limit=200', headers: adminHeaders })).json().items;
    expect(onlyCx.length).toBeGreaterThan(0);
    expect(onlyCx.every((x: { origin: string }) => x.origin === 'cx')).toBe(true);
    const onlyInternal = (await app.inject({ method: 'GET', url: '/v1/feedback?origin=internal&is_test=true&limit=200', headers: adminHeaders })).json().items;
    expect(onlyInternal.some((x: { id: string }) => x.id === cx.id)).toBe(false);

    const stats = (await app.inject({ method: 'GET', url: '/v1/feedback/stats?is_test=true&from=2026-08-01&to=2026-09-30', headers: adminHeaders })).json();
    const cxRow = stats.by_origin.find((x: { origin: string }) => x.origin === 'cx');
    expect(cxRow.issues).toBeGreaterThanOrEqual(3);
    expect(cxRow.open).toBe(cxRow.issues);
    expect(cxRow.oldest_open_at).toMatch(/^\d{4}-/);

    const analytics = (await app.inject({ method: 'GET', url: '/v1/analytics/overview?is_test=true&from=2026-08-01&to=2026-09-30', headers: adminHeaders })).json();
    expect(analytics.by_origin.map((x: { origin: string }) => x.origin)).toContain('cx');
    // A CX customer has no email; they still show up, by serial or resolved user id.
    expect(analytics.top_reporters.some((x: { origin: string; email: string | null }) => x.origin === 'cx' && x.email === null)).toBe(true);
  });
});

describe('attention', () => {
  it('lists open CX reports and old untouched ones, with the score explained', async () => {
    // Backdate one internal report past the untouched limit. It lives in UAT, where nothing else in
    // a shared database is old, so it cannot be crowded out of the section's top 25.
    const old = (await app.inject({ method: 'POST', url: '/v1/feedback/workout', headers: appHeaders, payload: internalBody({ issue_categories: ['incorrect_duration'], client: { environment: 'uat' } }) })).json();
    await app.db.query(`update luna_feedback.submissions set created_at = now() - interval '10 days' where id = $1`, [old.id]);

    const cxOnly = (await app.inject({ method: 'GET', url: '/v1/attention?is_test=true&origin=cx', headers: adminHeaders })).json();
    expect(cxOnly.thresholds.cx).toEqual({ untouched_days: 1, stale_days: 3 });
    expect(cxOnly.counts.cx_waiting).toBeGreaterThanOrEqual(3);
    expect(cxOnly.sections.cx_waiting.items.every((x: { origin: string }) => x.origin === 'cx')).toBe(true);
    const mine = cxOnly.sections.cx_waiting.items.find((x: { cx_ref: string }) => x.cx_ref === CX_REF('a'));
    if (mine) expect(mine.score_parts.impact).toBe(2); // an ungrouped customer counts twice

    const r = await app.inject({ method: 'GET', url: '/v1/attention?is_test=true&environment=uat', headers: adminHeaders });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    const flagged = a.sections.untouched.items.find((x: { id: string }) => x.id === old.id);
    expect(flagged).toBeDefined();
    expect(flagged.overdue_days).toBeGreaterThanOrEqual(6.9);
    expect(flagged.score_parts).toMatchObject({ severity: 2, impact: 1 });

    // Touching it (a status change) moves it out of "untouched".
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${old.id}`, headers: adminHeaders, payload: { status: 'triaged' } });
    const after = (await app.inject({ method: 'GET', url: '/v1/attention?is_test=true&environment=uat', headers: adminHeaders })).json();
    expect(after.sections.untouched.items.some((x: { id: string }) => x.id === old.id)).toBe(false);

    // Real data only by default.
    const real = (await app.inject({ method: 'GET', url: '/v1/attention', headers: adminHeaders })).json();
    expect(real.sections.cx_waiting.items.some((x: { id: string }) => x.id === old.id)).toBe(false);
  });
});

describe('log hosts per environment', () => {
  it('reports which environments can be diagnosed; UAT cannot until its host is set', async () => {
    const s = (await app.inject({ method: 'GET', url: '/v1/admin/diagnoses/summary', headers: adminHeaders })).json();
    expect(s.environments).toEqual({ stage: true, uat: false, production: true });

    const uat = (await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: internalBody({ client: { environment: 'uat' } }) })).json();
    const r = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${uat.id}/diagnose`, headers: adminHeaders });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain("isn't set up for uat");
    // Nothing was queued or recorded.
    const d = await app.db.query(`select 1 from luna_feedback.diagnosis_jobs where submission_id = $1`, [uat.id]);
    expect(d.rowCount).toBe(0);

    const lookup = await app.inject({ method: 'GET', url: '/v1/admin/logs/lookup?serial_no=X123&environment=uat', headers: adminHeaders });
    expect(lookup.statusCode).toBe(422);
  });
});

describe('the cx role', () => {
  const address = `cxagent+${run}@${DOMAIN}`;
  let cookie = '';
  let businessCookie = '';

  beforeAll(async () => {
    const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'cx' } })).json().generated_password;
    const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: pass } });
    cookie = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    const b = `biz+${run}@${DOMAIN}`;
    const bPass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: b, role: 'business' } })).json().generated_password;
    const bLogin = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: b, password: bPass } });
    businessCookie = String(bLogin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  });

  it('sees everything and may use the AI, but cannot triage or edit categories', async () => {
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { ...dash, cookie } })).json();
    expect(me.role).toBe('cx');
    expect(me.permissions).toMatchObject({ run_diagnosis: true, manage_triage: false, manage_jira: false, manage_kinds: false, manage_categories: false, review_diagnosis: false });

    const target = (await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: internalBody({ client: { environment: 'uat' } }) })).json();
    expect((await app.inject({ method: 'GET', url: `/v1/feedback/${target.ref}`, headers: { ...dash, cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/attention', headers: { ...dash, cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${target.id}`, headers: { ...dash, cookie }, payload: { status: 'triaged' } })).statusCode).toBe(403);
    // Allowed to diagnose: refused only because UAT has no log host here, not for the role.
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${target.id}/diagnose`, headers: { ...dash, cookie } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${target.id}/diagnose`, headers: { ...dash, cookie: businessCookie } })).statusCode).toBe(403);

    const cats = (await app.inject({ method: 'GET', url: '/v1/admin/features/sleep/issue-categories', headers: adminHeaders })).json().items;
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/issue-categories/${cats[0].id}`, headers: { ...dash, cookie }, payload: { label: cats[0].label } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/issue-categories/${cats[0].id}`, headers: { ...dash, cookie: businessCookie }, payload: { label: cats[0].label } })).statusCode).toBe(403);
  });
});
