import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';

/**
 * Sprints: filing into current / next, the Reports list leaving them out, moving, closing with
 * carry-over, reopening, deleting, creating and editing (docs/PLAN-sprints.md).
 *
 * Sprints are global (one current sprint), so this file takes the table over: it saves what is
 * there, works on its own two sprints, and puts everything back afterwards. It refuses to run
 * against anything but a local database.
 */
const DOMAIN = 'luna-sprints-test.invalid';
const run = `${Date.now()}`;
const USER = 900700 + Math.floor(Math.random() * 90);

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', CX_API_KEY: `cx_sprints_key_${run}` });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const cxHeaders = { 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };
const email = (who: string) => `${who}+${run}@${DOMAIN}`;
// 14 Oct 2026, 11:30 IST: the first sprint closes tomorrow.
const NOW = new Date('2026-10-14T06:00:00Z');

let n = 0;
const file = async (over: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url: '/v1/feedback/workout', headers: appHeaders,
  payload: { is_test: false, is_positive: false, occurred_on: '2026-10-10', user_id: USER, email: email(`r${n += 1}`), issue_categories: ['incorrect_duration'], feedback_text: `sprints test ${n} ${run}`, ...over },
});
const report = async (over: Record<string, unknown> = {}) => (await file(over)).json() as { id: string; ref: string; sprint: { ref: string } | null; status: string };
const get = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: adminHeaders })).json();
const history = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}/activity`, headers: adminHeaders })).json().items as { action: string; from_value: string | null; to_value: string | null; note: string | null }[];
const homeRefs = async (q = '') => ((await app.inject({ method: 'GET', url: `/v1/home/reports?user_id=${USER}&page_size=100${q}`, headers: adminHeaders })).json().items as { ref: string }[]).map((x) => x.ref);
const sprint = async (ref: string) => (await app.inject({ method: 'GET', url: `/v1/sprints/${ref}`, headers: adminHeaders })).json();

const cookies: Record<string, string> = {};
async function account(who: string, role: string) {
  const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email(who), role, name: who } })).json().generated_password;
  const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email(who), password: pass } });
  cookies[who] = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}
const as = (who: string) => ({ ...dash, cookie: cookies[who]! });

// What was there before, put back afterwards.
let savedSprints: Record<string, unknown>[] = [];
let savedLinks: { id: string; sprint_id: string }[] = [];

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1 or cx_ref like $2`, [`%@${DOMAIN}`, `zz-spr-${run}%`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  const host = new URL(cfg.SUPABASE_DB_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`sprints.test.ts rewrites the sprints table; run it against a local database, not ${host}`);
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null }, now: () => NOW });
  await app.ready();
  await cleanup();
  savedSprints = (await app.db.query(`select id, ref, name, goal, starts_on::text as starts_on, ends_on::text as ends_on, status, created_by, created_at, updated_at, activated_at, closed_by, closed_at from luna_feedback.sprints`)).rows;
  savedLinks = (await app.db.query<{ id: string; sprint_id: string }>(`select id, sprint_id from luna_feedback.submissions where sprint_id is not null`)).rows;
  await app.db.query(`update luna_feedback.submissions set sprint_id = null where sprint_id is not null`);
  await app.db.query(`delete from luna_feedback.sprints`);
  await app.db.query(`insert into luna_feedback.sprints (ref, name, starts_on, ends_on, status, created_by, activated_at) values
    ('SPR-202610-01', 'Sprint · October 2026 · 01', '2026-10-01', '2026-10-15', 'active', 'test', now()),
    ('SPR-202610-02', 'Sprint · October 2026 · 02', '2026-10-16', '2026-10-31', 'planned', 'test', null)`);
  await account('qc', 'qc');
  await account('dev', 'developer');
});

afterAll(async () => {
  await cleanup();
  await app.db.query(`update luna_feedback.submissions set sprint_id = null where sprint_id is not null`);
  await app.db.query(`delete from luna_feedback.sprints`);
  for (const s of savedSprints) {
    const cols = Object.keys(s);
    await app.db.query(`insert into luna_feedback.sprints (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => s[c]));
  }
  for (const l of savedLinks) await app.db.query(`update luna_feedback.submissions set sprint_id = $2 where id = $1`, [l.id, l.sprint_id]);
  await app.close();
});

describe('the app files into a sprint', () => {
  it('offers the current and the next sprint, with the days left', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/sprints/options', headers: appHeaders });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      current: { ref: 'SPR-202610-01', ends_on: '2026-10-15', days_left: 1, overdue_days: 0, exists: true },
      next: { ref: 'SPR-202610-02', starts_on: '2026-10-16', exists: true },
    });
    const schema = (await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders })).json();
    expect(schema.sprints).toMatchObject({ field: 'sprint', values: ['current', 'next'], options_endpoint: '/v1/sprints/options' });
  });

  it('files into current or next, and says so in the history', async () => {
    const cur = await report({ sprint: 'current' });
    expect(cur.sprint).toMatchObject({ ref: 'SPR-202610-01', status: 'active' });
    expect((await history(cur.id)).map((e) => [e.action, e.to_value])).toEqual([['created', 'internal'], ['sprint', 'SPR-202610-01']]);
    const next = await report({ sprint: 'next' });
    expect(next.sprint).toMatchObject({ ref: 'SPR-202610-02', status: 'planned' });
    const none = await report({ sprint: null });
    expect(none.sprint).toBeNull();
  });

  it('refuses a sprint on positive feedback, on CX reports, and anything but current / next', async () => {
    const pos = await file({ is_positive: true, issue_categories: [], sprint: 'current' });
    expect(pos.statusCode).toBe(422);
    expect(pos.json().error.issues).toContainEqual({ path: 'sprint', message: 'is only for issues (is_positive: false)' });
    const bad = await file({ sprint: 'SPR-202610-01' });
    expect(bad.statusCode).toBe(422);
    const cx = await app.inject({
      method: 'POST', url: '/v1/cx/feedback/workout', headers: cxHeaders,
      payload: { is_test: false, is_positive: false, occurred_on: '2026-10-10', device_serial: 'R2NSPR0001', issue_categories: ['incorrect_duration'], cx: { ref: `zz-spr-${run}-1` }, sprint: 'current' },
    });
    expect(cx.statusCode).toBe(422);
    expect(cx.json().error.issues[0].path).toBe('sprint');
  });
});

describe('where sprint issues show up', () => {
  it('leaves them off the Reports list and Needs attention unless asked', async () => {
    const inSprint = await report({ sprint: 'current' });
    const main = await report();
    const list = await homeRefs();
    expect(list).toContain(main.ref);
    expect(list).not.toContain(inSprint.ref);
    expect(await homeRefs('&sprint=current')).toContain(inSprint.ref);
    expect(await homeRefs('&sprint=SPR-202610-01')).toContain(inSprint.ref);
    expect(await homeRefs('&sprint=any')).not.toContain(main.ref);
    expect((await app.inject({ method: 'GET', url: `/v1/home/reports?sprint=bogus`, headers: adminHeaders })).statusCode).toBe(422);
    // Everything else still sees every report.
    const all = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=${USER}&limit=200`, headers: adminHeaders })).json().items.map((x: { ref: string }) => x.ref);
    expect(all).toEqual(expect.arrayContaining([inSprint.ref, main.ref]));

    // Needs attention: measured as a difference, so other reports in the database do not matter.
    const open = async () => (await app.inject({ method: 'GET', url: '/v1/attention/counts?environment=uat', headers: adminHeaders })).json().open as number;
    const base = await open();
    await report({ sprint: 'current', client: { environment: 'uat' } });
    expect(await open()).toBe(base);
    await report({ client: { environment: 'uat' } });
    expect(await open()).toBe(base + 1);
  });

  it('tells the Reports page how many open issues the current sprint holds', async () => {
    const home = (await app.inject({ method: 'GET', url: '/v1/home', headers: adminHeaders })).json();
    expect(home.sprint).toMatchObject({ ref: 'SPR-202610-01' });
    expect(home.sprint.open).toBeGreaterThan(0);
  });
});

describe('moving reports', () => {
  it('lets QC move a report between sprints and back to the main list, and records it', async () => {
    const r = await report();
    const toNext = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { sprint: 'next' } });
    expect(toNext.statusCode).toBe(200);
    expect(toNext.json().sprint.ref).toBe('SPR-202610-02');
    const back = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { sprint: null } });
    expect(back.json().sprint).toBeNull();
    const moves = (await history(r.id)).filter((e) => e.action === 'sprint').map((e) => [e.from_value, e.to_value]);
    expect(moves).toEqual([[null, 'SPR-202610-02'], ['SPR-202610-02', null]]);
    // A move is bookkeeping, not the team responding.
    expect((await get(r.id)).first_touched_at).toBeNull();
  });

  it('refuses developers, positive feedback and unknown sprints', async () => {
    const r = await report();
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('dev'), payload: { sprint: 'current' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/submissions/bulk', headers: as('dev'), payload: { ids: [r.id], sprint: 'current' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { sprint: 'SPR-209901-01' } })).statusCode).toBe(404);
    const pos = await report({ is_positive: true, issue_categories: [] });
    const p = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${pos.id}`, headers: as('qc'), payload: { sprint: 'current' } });
    expect(p.statusCode).toBe(422);
  });

  it('moves many at once from the bulk bar', async () => {
    const a = await report(); const b = await report();
    const out = (await app.inject({ method: 'POST', url: '/v1/admin/submissions/bulk', headers: as('qc'), payload: { ids: [a.id, b.ref], sprint: 'current' } })).json();
    expect(out).toEqual({ updated: 2, failed: [] });
    expect((await get(a.id)).sprint.ref).toBe('SPR-202610-01');
  });
});

describe('reading sprints', () => {
  it('lists sprints with counts and timing', async () => {
    const out = (await app.inject({ method: 'GET', url: '/v1/sprints', headers: adminHeaders })).json();
    expect(out).toMatchObject({ today: '2026-10-14', current: 'SPR-202610-01', next: 'SPR-202610-02' });
    const cur = out.items.find((s: { ref: string }) => s.ref === 'SPR-202610-01');
    expect(cur).toMatchObject({ status: 'active', is_current: true, day: 14, days: 15, days_left: 1, range: '1–15 Oct 2026', delete_blocked_by: 'SPR-202610-01 is the current sprint. Close it first.' });
    expect(cur.counts.issues).toBeGreaterThanOrEqual(4);
    expect(cur.counts.open).toBe(cur.counts.issues);
  });

  it('reads one sprint by reference or alias, with its features and days', async () => {
    const s = await sprint('current');
    expect(s.ref).toBe('SPR-202610-01');
    expect(s.by_feature[0]).toMatchObject({ feature_key: 'workout' });
    expect(Array.isArray(s.per_day)).toBe(true);
    expect(s).toMatchObject({ follows: 'SPR-202610-02', prev: null, after: 'SPR-202610-02' });
    expect((await app.inject({ method: 'GET', url: '/v1/sprints/SPR-209901-01', headers: adminHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/sprints/nope', headers: adminHeaders })).statusCode).toBe(422);
  });
});

describe('closing a sprint', () => {
  let done: { id: string; ref: string };
  let kept: { id: string; ref: string };
  let toMain: { id: string; ref: string };
  let toNext: { id: string; ref: string };

  it('only QC and admins close, and only the current sprint', async () => {
    done = await report({ sprint: 'current' });
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${done.id}`, headers: as('qc'), payload: { status: 'resolved' } });
    kept = await report({ sprint: 'current' });
    await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${kept.id}`, headers: as('qc'), payload: { status: 'wont_fix' } });
    toMain = await report({ sprint: 'current' });
    toNext = await report({ sprint: 'current' });
    expect((await app.inject({ method: 'POST', url: '/v1/admin/sprints/SPR-202610-01/close', headers: as('dev'), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/sprints/SPR-202610-02/close', headers: as('qc'), payload: {} })).statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/v1/admin/sprints/SPR-202610-01/close', headers: as('qc'), payload: { overrides: { 'LN-99999999': 'main' } } });
    expect(bad.statusCode).toBe(422);
    expect((await sprint('SPR-202610-01')).status).toBe('active'); // a bad override changes nothing
  });

  it('carries open issues over, makes the next sprint current and plans another', async () => {
    // History survives a sprint (moves name refs), so compare with what was counted before.
    const outBefore = (await sprint('SPR-202610-01')).counts.carried_out as number;
    const inBefore = (await sprint('SPR-202610-02')).counts.carried_in as number;
    const r = await app.inject({ method: 'POST', url: '/v1/admin/sprints/SPR-202610-01/close', headers: as('qc'), payload: { default: 'next', overrides: { [toMain.ref]: 'main' } } });
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ closed: 'SPR-202610-01', current: 'SPR-202610-02', next: 'SPR-202611-01', to_main: 1 });
    expect(out.to_next).toBeGreaterThanOrEqual(1);
    expect(out.moved).toContainEqual({ ref: toMain.ref, to: null });
    expect(out.moved).toContainEqual({ ref: toNext.ref, to: 'SPR-202610-02' });

    expect((await get(done.id)).sprint).toMatchObject({ ref: 'SPR-202610-01', status: 'closed' });
    expect((await get(kept.id)).sprint).toMatchObject({ ref: 'SPR-202610-01', status: 'closed' });
    expect((await get(toMain.id)).sprint).toBeNull();
    expect((await get(toNext.id)).sprint).toMatchObject({ ref: 'SPR-202610-02', status: 'active' });
    expect((await history(toNext.id)).at(-1)).toMatchObject({ action: 'sprint', from_value: 'SPR-202610-01', to_value: 'SPR-202610-02', note: 'Carried over when SPR-202610-01 closed' });

    const closed = await sprint('SPR-202610-01');
    expect(closed).toMatchObject({ status: 'closed', closed_by: email('qc'), delete_blocked_by: null });
    expect(closed.counts.open).toBe(0);
    expect(closed.counts.carried_out - outBefore).toBe(out.moved.length);
    expect((await sprint('current')).counts.carried_in - inBefore).toBe(out.to_next);
    expect((await sprint('next')).ref).toBe('SPR-202611-01');
    // Closed early: the new current sprint has not reached its dates yet.
    expect(await sprint('current')).toMatchObject({ is_current: true, starts_in: 2, day: null });

    const again = await app.inject({ method: 'POST', url: '/v1/admin/sprints/SPR-202610-01/close', headers: as('qc'), payload: {} });
    expect(again.statusCode).toBe(409);
    const one = await app.db.query(`select count(*)::int as n from luna_feedback.sprints where status = 'active'`);
    expect(one.rows[0].n).toBe(1);
  });

  it('moves an issue reopened in a closed sprint to the current one', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${done.id}`, headers: as('qc'), payload: { status: 'in_progress' } });
    expect(r.json().sprint).toMatchObject({ ref: 'SPR-202610-02', status: 'active' });
    expect((await history(done.id)).at(-1)).toMatchObject({ action: 'sprint', from_value: 'SPR-202610-01', to_value: 'SPR-202610-02', note: 'Reopened, so moved to the current sprint' });
  });

  it('never files or moves into a closed sprint', async () => {
    const r = await report();
    const p = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${r.id}`, headers: as('qc'), payload: { sprint: 'SPR-202610-01' } });
    expect(p.statusCode).toBe(409);
  });
});

describe('planning and editing sprints', () => {
  it('creates the next free half by default, and only QC and admins may', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/admin/sprints', headers: as('dev'), payload: {} })).statusCode).toBe(403);
    const r = await app.inject({ method: 'POST', url: '/v1/admin/sprints', headers: as('qc'), payload: { goal: 'Firmware 1.9.4' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ref: 'SPR-202611-02', name: 'Sprint · November 2026 · 02', starts_on: '2026-11-16', ends_on: '2026-11-30', status: 'planned', goal: 'Firmware 1.9.4' });
  });

  it('refuses overlaps, past sprints, a second sprint in a half, and over-long ones', async () => {
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/admin/sprints', headers: as('qc'), payload });
    const overlap = await post({ starts_on: '2026-12-01', ends_on: '2026-12-15' }); // fine
    expect(overlap.statusCode).toBe(201);
    const clash = await post({ starts_on: '2026-12-20', ends_on: '2026-12-31' });
    expect(clash.statusCode).toBe(201);
    expect((await post({ starts_on: '2026-12-25', ends_on: '2027-01-05' })).statusCode).toBe(422); // same half as the one above
    const o = await post({ starts_on: '2027-01-01', ends_on: '2027-01-10' });
    expect(o.statusCode).toBe(201);
    const over = await post({ starts_on: '2027-01-16', ends_on: '2027-01-05' });
    expect(over.json().error.issues[0]).toMatchObject({ path: 'ends_on' });
    expect((await post({ starts_on: '2027-02-01', ends_on: '2027-05-01' })).statusCode).toBe(422);
    expect((await post({ starts_on: '2026-09-16', ends_on: '2026-09-30' })).statusCode).toBe(422);
    const lap = await post({ starts_on: '2027-01-16', ends_on: '2027-01-31' });
    expect(lap.statusCode).toBe(201);
    const into = await app.inject({ method: 'PATCH', url: '/v1/admin/sprints/SPR-202701-01', headers: as('qc'), payload: { ends_on: '2027-01-20' } });
    expect(into.statusCode).toBe(422);
    expect(into.json().error.issues[0].message).toMatch(/overlaps SPR-202701-02/);
  });

  it('edits a sprint but keeps its reference, fixes the start of the current one, and leaves closed ones alone', async () => {
    const ok = await app.inject({ method: 'PATCH', url: '/v1/admin/sprints/SPR-202611-02', headers: as('qc'), payload: { name: 'Sprint · November 2026 · 02 — FW 1.9.4', ends_on: '2026-11-28', goal: null } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ends_on: '2026-11-28', goal: null });
    expect((await app.inject({ method: 'PATCH', url: '/v1/admin/sprints/SPR-202611-02', headers: as('qc'), payload: { starts_on: '2026-11-10' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: '/v1/admin/sprints/current', headers: as('qc'), payload: { starts_on: '2026-10-17' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: '/v1/admin/sprints/current', headers: as('qc'), payload: { ends_on: '2026-10-30' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/v1/admin/sprints/SPR-202610-01', headers: as('qc'), payload: { name: 'x' } })).statusCode).toBe(409);
  });
});

describe('deleting a sprint', () => {
  it('is for admins only, needs the reference typed, and never touches the current sprint', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/sprints/SPR-202610-01?confirm=SPR-202610-01', headers: as('qc') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/sprints/SPR-202610-01', headers: adminHeaders })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/sprints/current?confirm=SPR-202610-02', headers: adminHeaders })).statusCode).toBe(409);
  });

  it('refuses while anything in it is open', async () => {
    await report({ sprint: 'next' }); // SPR-202611-01, planned
    const r = await app.inject({ method: 'DELETE', url: '/v1/admin/sprints/SPR-202611-01?confirm=SPR-202611-01', headers: adminHeaders });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/still open/);
    expect((await sprint('SPR-202611-01')).delete_blocked_by).toMatch(/still open/);
  });

  it('deletes a closed sprint with its closed issues, and nothing else', async () => {
    const before = await app.db.query<{ id: string }>(`select s.id from luna_feedback.submissions s join luna_feedback.sprints sp on sp.id = s.sprint_id where sp.ref = 'SPR-202610-01'`);
    const r = await app.inject({ method: 'DELETE', url: '/v1/admin/sprints/SPR-202610-01?confirm=spr-202610-01', headers: adminHeaders });
    expect(r.statusCode).toBe(200);
    expect(before.rows.length).toBeGreaterThan(0);
    expect(r.json()).toEqual({ ref: 'SPR-202610-01', deleted_issues: before.rows.length });
    expect((await app.inject({ method: 'GET', url: '/v1/sprints/SPR-202610-01', headers: adminHeaders })).statusCode).toBe(404);
    for (const { id } of before.rows) expect((await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: adminHeaders })).statusCode).toBe(404);
    // Reports that were carried out of it are still there.
    expect((await homeRefs('&sprint=any')).length).toBeGreaterThan(0);
  });
});
