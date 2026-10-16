import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { ASSIGN_BACK_DEFAULTS } from '../../src/modules/feedback/assign-back.js';

/**
 * Marking a report Fixed or Won't fix hands it back to whoever filed it; a reporter without a
 * dashboard account hands it to Kuldeep, or Shaifali when his account is disabled.
 *
 * The defaults are hard-coded production user ids, so this file creates accounts with those ids and
 * refuses to run against anything but a local database.
 */
const DOMAIN = 'luna-assignback-test.invalid';
const run = `${Date.now()}`;
const email = (who: string) => `${who}+${run}@${DOMAIN}`;
const [KULDEEP, SHAIFALI] = ASSIGN_BACK_DEFAULTS.map((d) => d.id) as [string, string];

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent' });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

const cookies: Record<string, string> = {};
async function account(who: string, role: string) {
  const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email(who), role, name: who } })).json().generated_password;
  const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email(who), password: pass } });
  cookies[who] = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}
const as = (who: string) => ({ ...dash, cookie: cookies[who]! });

let n = 0;
const file = async (reporter: string, headers: Record<string, string> = appHeaders) => (await app.inject({
  method: 'POST', url: '/v1/feedback/home', headers: { ...headers, 'idempotency-key': `ab-${run}-${n += 1}` },
  payload: { is_test: true, is_positive: false, occurred_on: '2026-10-15', user_id: 900600 + n, email: reporter, issue_categories: ['wrong_peak_score'], feedback_text: `assign back ${n} ${run}` },
})).json() as { id: string; ref: string; assigned_to: string | null };
const patch = (id: string, payload: unknown, who = 'qc') => app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}`, headers: as(who), payload: payload as object });
const owner = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: adminHeaders })).json().assigned_to as string | null;
const lastAssign = async (id: string) => ((await app.inject({ method: 'GET', url: `/v1/feedback/${id}/activity`, headers: adminHeaders })).json().items as { action: string }[])
  .filter((e) => e.action === 'assign').at(-1);
const disable = (id: string, off: boolean) => app.db.query(`update luna_feedback.dashboard_users set is_disabled = $2 where id = $1`, [id, off]);

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1 or id = any($2::uuid[])`, [`%@${DOMAIN}`, [KULDEEP, SHAIFALI]]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  const host = new URL(cfg.SUPABASE_DB_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`assign-back.test.ts creates accounts with production user ids; run it against a local database, not ${host}`);
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
  await account('qc', 'qc');
  await account('dev', 'developer');
  await account('tester', 'business');
  await account('filer', 'business');
  await app.db.query(`insert into luna_feedback.dashboard_users (id, email, name, role, password_hash) values
    ($1, $3, 'Kuldeep Sachan', 'qc', 'x'), ($2, $4, 'Shaifali', 'qc', 'x')`, [KULDEEP, SHAIFALI, email('kuldeep'), email('shaifali')]);
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('Fixed or Won\'t fix hands the report back', () => {
  it('to the tester who filed it, when they have a dashboard account, and says why', async () => {
    const r = await file(email('tester'));
    await patch(r.id, { assigned_to: email('dev') });
    // A developer may mark it fixed; the report still goes back to the tester.
    const res = await patch(r.id, { status: 'fixed' }, 'dev');
    expect(res.statusCode).toBe(200);
    expect(res.json().assigned_to).toBe(email('tester'));
    expect(await lastAssign(r.id)).toMatchObject({ actor: email('dev'), from_value: email('dev'), to_value: email('tester'), note: 'back to the reporter, marked Fixed' });
  });

  it('to Kuldeep when the reporter has no dashboard account, and to Shaifali when he is disabled', async () => {
    const a = await file(email('no-account'));
    expect((await patch(a.id, { status: 'wont_fix' })).json().assigned_to).toBe(email('kuldeep'));
    expect(await lastAssign(a.id)).toMatchObject({ to_value: email('kuldeep'), note: "marked Won't fix; the reporter has no dashboard account" });

    await disable(KULDEEP, true);
    try {
      const b = await file(email('no-account'));
      expect((await patch(b.id, { status: 'fixed' })).json().assigned_to).toBe(email('shaifali'));
      await disable(SHAIFALI, true);
      const c = await file(email('no-account'));
      await patch(c.id, { assigned_to: email('dev') });
      expect((await patch(c.id, { status: 'fixed' })).json().assigned_to).toBe(email('dev')); // nobody to hand it to: unchanged
    } finally { await disable(KULDEEP, false); await disable(SHAIFALI, false); }
  });

  it('to the person who filed it on the dashboard, not the email typed in the form', async () => {
    const r = await file(email('tester'), as('filer'));
    expect((await patch(r.id, { status: 'fixed' })).json().assigned_to).toBe(email('filer'));
  });

  it('in bulk too', async () => {
    const a = await file(email('tester'));
    const b = await file(email('no-account'));
    const res = await app.inject({ method: 'POST', url: '/v1/admin/submissions/bulk', headers: as('qc'), payload: { ids: [a.id, b.ref], status: 'wont_fix' } });
    expect(res.json()).toMatchObject({ updated: 2, failed: [] });
    expect(await owner(a.id)).toBe(email('tester'));
    expect(await owner(b.id)).toBe(email('kuldeep'));
  });

  it('keeps an owner named in the same change, and leaves other statuses and repeats alone', async () => {
    const r = await file(email('tester'));
    expect((await patch(r.id, { status: 'fixed', assigned_to: email('dev') })).json().assigned_to).toBe(email('dev'));
    // Already fixed: setting it again changes nothing.
    expect((await patch(r.id, { status: 'fixed', status_note: 'still fixed' })).json().assigned_to).toBe(email('dev'));
    const bulk = await file(email('tester'));
    await app.inject({ method: 'POST', url: '/v1/admin/submissions/bulk', headers: as('qc'), payload: { ids: [bulk.id], status: 'fixed', assigned_to: email('qc') } });
    expect(await owner(bulk.id)).toBe(email('qc'));

    const other = await file(email('tester'));
    for (const status of ['triaged', 'in_progress', 'resolved', 'closed']) expect((await patch(other.id, { status })).json().assigned_to).toBeNull();
  });
});
