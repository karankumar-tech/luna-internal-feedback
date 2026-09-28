import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';

/**
 * Accountability: the activity log and notes, owners, priority and its time limits, needs_info and
 * the CX reply that ends it, bulk changes and response times. Rows are is_test and removed afterwards.
 */
const DOMAIN = 'luna-activity-test.invalid';
const run = `${Date.now()}`;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', CX_API_KEY: `cx_activity_key_${run}` });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const cxHeaders = { 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };
const email = (who: string) => `${who}+${run}@${DOMAIN}`;

let n = 0;
const report = async (over: Record<string, unknown> = {}, feature = 'workout') => (await app.inject({
  method: 'POST', url: `/v1/feedback/${feature}`, headers: appHeaders,
  payload: { is_test: true, is_positive: false, occurred_on: '2026-06-01', user_id: 900300 + (n += 1), email: email(`r${n}`), issue_categories: ['incorrect_duration'], feedback_text: `activity test ${n} ${run}`, ...over },
})).json() as { id: string; ref: string };
const cxReport = async () => (await app.inject({
  method: 'POST', url: '/v1/cx/feedback/workout', headers: cxHeaders,
  payload: { is_test: true, is_positive: false, occurred_on: '2026-06-01', device_serial: `R2NACT${run.slice(-6)}`, issue_categories: ['incorrect_duration'], feedback_text: 'customer says the run lost 10 minutes', cx: { ref: `zz-act-${run}-${n += 1}` } },
})).json() as { id: string; ref: string };
const history = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}/activity`, headers: appHeaders })).json().items as { action: string; actor: string | null; from_value: string | null; to_value: string | null; note: string | null; visibility: string }[];
const get = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: adminHeaders })).json();
const attention = async (q = '') => (await app.inject({ method: 'GET', url: `/v1/attention?is_test=true&environment=uat${q}`, headers: adminHeaders })).json();

const cookies: Record<string, string> = {};
async function account(who: string, role: string) {
  const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email(who), role, name: who } })).json().generated_password;
  const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email(who), password: pass } });
  cookies[who] = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}
const as = (who: string) => ({ ...dash, cookie: cookies[who]! });

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1 or cx_ref like $2`, [`%@${DOMAIN}`, `zz-act-${run}%`]);
  await app.db.query(`delete from luna_feedback.issue_kinds where key like $1`, [`zz_act_${run}%`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
  await account('qc', 'qc');
  await account('dev', 'developer');
  await account('cx', 'cx');
  await account('biz', 'business');
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('history and the response clock', () => {
  it('records the report arriving, and starts the clock only when the team acts', async () => {
    const r = await report();
    expect((await history(r.id)).map((e) => [e.action, e.actor])).toEqual([['created', 'app']]);
    expect(await get(r.id)).toMatchObject({ first_touched_at: null, last_activity_at: null, resolved_at: null });

    const moved = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { status: 'triaged', status_note: 'looking' } });
    expect(moved.statusCode).toBe(200);
    const h = await history(r.id);
    expect(h[1]).toMatchObject({ action: 'status', actor: email('qc'), from_value: 'open', to_value: 'triaged', note: 'looking' });
    const after = await get(r.id);
    expect(after.first_touched_at).toMatch(/^\d{4}-/);
    expect(after.last_activity_at).toMatch(/^\d{4}-/);

    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { status: 'resolved' } });
    expect((await get(r.id)).resolved_at).toMatch(/^\d{4}-/);
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { status: 'in_progress' } });
    expect((await get(r.id)).resolved_at).toBeNull();
  });
});

describe('owners and priority', () => {
  it('assigns to any dashboard user, logs it, and refuses someone without an account', async () => {
    const r = await report();
    const ok = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { assigned_to: email('dev'), priority: 'p1' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ assigned_to: email('dev'), priority: 'p1' });
    const h = await history(r.id);
    expect(h.map((e) => e.action)).toEqual(['created', 'assign', 'priority']);
    expect(h[1]).toMatchObject({ to_value: email('dev') });

    const bad = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { assigned_to: 'nobody@example.com' } });
    expect(bad.statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('dev'), payload: { priority: 'p0' } })).statusCode).toBe(403);

    const people = (await app.inject({ method: 'GET', url: '/v1/admin/assignees', headers: as('biz') })).json().items;
    expect(people.map((p: { email: string }) => p.email)).toEqual(expect.arrayContaining([email('qc'), email('dev'), email('cx'), email('biz')]));
  });

  it('"my queue" finds what is assigned to the signed-in person', async () => {
    const r = await report({ client: { environment: 'uat' } });
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { assigned_to: email('dev') } });
    const mine = (await app.inject({ method: 'GET', url: '/v1/feedback?assigned_to=me&is_test=true', headers: as('dev') })).json().items;
    expect(mine.some((x: { id: string }) => x.id === r.id)).toBe(true);
    expect(mine.every((x: { assigned_to: string }) => x.assigned_to === email('dev'))).toBe(true);
    const none = (await app.inject({ method: 'GET', url: '/v1/feedback?assigned_to=none&is_test=true&limit=200', headers: adminHeaders })).json().items;
    expect(none.some((x: { id: string }) => x.id === r.id)).toBe(false);
    const a = (await app.inject({ method: 'GET', url: '/v1/attention?is_test=true&environment=uat', headers: as('dev') })).json();
    expect(a.counts.mine).toBeGreaterThanOrEqual(1);
  });

  it('a P0 is flagged after four hours untouched; a P3 gets twice the usual time', async () => {
    const p0 = await report({ client: { environment: 'uat' } });
    const p3 = await report({ client: { environment: 'uat' } });
    // Priority set by automation (no clock), then backdated: five hours untouched.
    await app.db.query(`update luna_feedback.submissions set priority = 'p0', created_at = now() - interval '5 hours' where id = $1`, [p0.id]);
    await app.db.query(`update luna_feedback.submissions set priority = 'p3', created_at = now() - interval '4 days' where id = $1`, [p3.id]);
    const a = await attention();
    const hot = a.sections.untouched.items.find((x: { id: string }) => x.id === p0.id);
    expect(hot).toMatchObject({ priority: 'p0', score_parts: { severity: 4 } });
    // Internal default is 3 days untouched; P3 doubles it to 6, so 4 days is not yet flagged.
    expect(a.sections.untouched.items.some((x: { id: string }) => x.id === p3.id)).toBe(false);
    expect(a.thresholds.priority.p0).toEqual({ untouched_days: 4 / 24, stale_days: 1 });
  });
});

describe('notes and needs info', () => {
  it('lets QC, developers and CX write notes, but not business; CX report notes are redacted', async () => {
    const r = await report();
    const dev = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${r.id}/notes`, headers: as('dev'), payload: { body: 'Reproduced on 1.9.3.' } });
    expect(dev.statusCode).toBe(201);
    expect(dev.json()).toMatchObject({ action: 'note', actor: email('dev'), visibility: 'internal' });
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${r.id}/notes`, headers: as('cx'), payload: { body: 'Customer called again', visibility: 'customer' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${r.id}/notes`, headers: as('biz'), payload: { body: 'hello' } })).statusCode).toBe(403);
    expect((await get(r.id)).first_touched_at).toMatch(/^\d{4}-/);

    const c = await cxReport();
    await app.inject({ method: 'POST', url: `/v1/admin/submissions/${c.id}/notes`, headers: as('cx'), payload: { body: 'She wrote from jane@example.com' } });
    const notes = (await history(c.id)).filter((e) => e.action === 'note');
    expect(notes[0]!.note).toContain('[REDACTED_EMAIL]');
  });

  it('asks the customer, shows the questions to the CX tool, and a reply puts the report back', async () => {
    const c = await cxReport();
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${c.id}`, headers: as('qc'), payload: { status: 'in_progress' } });
    const ask = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${c.id}/ask-reporter`, headers: as('qc'), payload: { questions: ['Was the ring charging?', 'Which workout type?'] } });
    expect(ask.statusCode).toBe(200);
    expect(ask.json().status).toBe('needs_info');

    const seen = (await app.inject({ method: 'GET', url: `/v1/cx/feedback/${c.ref}`, headers: cxHeaders })).json();
    expect(seen.status).toBe('needs_info');
    expect(seen.latest_update.body).toContain('Was the ring charging?');

    const touchedBefore = (await get(c.id)).first_touched_at;
    const reply = await app.inject({ method: 'POST', url: `/v1/cx/feedback/${c.ref}/notes`, headers: cxHeaders, payload: { body: 'Customer: no, it was on the wrist. Outdoor run.', agent: 'Asha' } });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().status).toBe('in_progress');
    const h = await history(c.id);
    expect(h.find((e) => e.action === 'note' && e.actor === 'cx_tool · Asha')).toBeDefined();
    expect(h[h.length - 1]).toMatchObject({ action: 'status', from_value: 'needs_info', to_value: 'in_progress', note: 'Reporter replied' });
    expect((await get(c.id)).first_touched_at).toBe(touchedBefore);

    // Internal reports and the app key are kept out of the CX notes route.
    const internal = await report();
    expect((await app.inject({ method: 'POST', url: `/v1/cx/feedback/${internal.ref}/notes`, headers: cxHeaders, payload: { body: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/cx/feedback/${c.ref}/notes`, headers: appHeaders, payload: { body: 'x' } })).statusCode).toBe(401);
  });

  it('waiting on the reporter is neither untouched nor stale until it has waited a week', async () => {
    const r = await report({ client: { environment: 'uat' } });
    await app.inject({ method: 'POST', url: `/v1/admin/submissions/${r.id}/ask-reporter`, headers: as('qc'), payload: { questions: ['When did it start?'] } });
    await app.db.query(`update luna_feedback.submissions set created_at = now() - interval '20 days', last_activity_at = now() - interval '8 days' where id = $1`, [r.id]);
    const a = await attention();
    expect(a.sections.needs_info.items.some((x: { id: string }) => x.id === r.id)).toBe(true);
    expect(a.sections.stale.items.some((x: { id: string }) => x.id === r.id)).toBe(false);
    expect(a.sections.untouched.items.some((x: { id: string }) => x.id === r.id)).toBe(false);
  });
});

describe('bulk changes', () => {
  it('applies one change to many reports and logs each; unknown ones are reported, not fatal', async () => {
    const a = await report();
    const b = await report();
    const r = await app.inject({ method: 'POST', url: '/v1/admin/submissions/bulk', headers: as('qc'), payload: { ids: [a.ref, b.id, 'LN-99999999'], assigned_to: email('qc'), priority: 'p2', status: 'triaged' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated).toBe(2);
    expect(r.json().failed).toEqual([{ id: 'LN-99999999', error: expect.any(String) }]);
    expect(await get(b.id)).toMatchObject({ assigned_to: email('qc'), priority: 'p2', status: 'triaged' });
    expect((await history(a.id)).map((e) => e.action)).toEqual(['created', 'assign', 'priority', 'status']);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/submissions/bulk', headers: as('dev'), payload: { ids: [a.id], status: 'closed' } })).statusCode).toBe(403);
  });
});

describe('problem owners and response times', () => {
  it('gives a problem an owner', async () => {
    const k = (await app.inject({ method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { title: `ZZ act ${run} workout time lost`, key: `zz_act_${run}_kind` } })).json();
    const ok = await app.inject({ method: 'PATCH', url: `/v1/admin/kinds/${k.id}`, headers: as('qc'), payload: { owner: email('dev') } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().owner).toBe(email('dev'));
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/kinds/${k.id}`, headers: as('qc'), payload: { owner: 'ghost@example.com' } })).statusCode).toBe(422);
  });

  it('reports time to first response, to resolve, and in each status', async () => {
    const a = (await app.inject({ method: 'GET', url: '/v1/analytics/overview?is_test=true&from=2026-05-01&to=2026-07-01', headers: adminHeaders })).json();
    const internal = a.response_times.find((r: { origin: string }) => r.origin === 'internal');
    expect(internal.touched).toBeGreaterThan(0);
    expect(internal.first_response_p50_h).toBeGreaterThanOrEqual(0);
    expect(a.time_in_status.map((s: { status: string }) => s.status)).toEqual(expect.arrayContaining(['open', 'triaged']));
  });
});
