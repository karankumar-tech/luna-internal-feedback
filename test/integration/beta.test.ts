import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { ImageKitClient } from '../../src/modules/uploads/imagekit.js';

/**
 * Beta users: the list in Settings, the released app's key and its lane, the cached check, and
 * reports filed as origin 'beta'. Every report is is_test; rows are removed by this run's user ids.
 */
const DOMAIN = 'luna-test.invalid';
const run = `${Date.now()}`;
// Ids no real Luna user has: 97 followed by this run's digits.
const U = (n: number) => Number(`97${run.slice(-8)}${n}`);
const [BETA_A, BETA_B, OUTSIDER] = [U(1), U(2), U(3)];
const IDS = [BETA_A, BETA_B, OUTSIDER];

let app: App;
const cfg = loadConfig({
  NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent',
  BETA_API_KEY: `beta_test_key_${run}`, BETA_USERS_CACHE_TTL_MS: '3600000',
});
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const betaHeaders = { 'x-api-key': cfg.BETA_API_KEY!, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

const betaBody = (userId: number, over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-10-20', user_id: userId, email: `someone+${run}@example.com`,
  issue_categories: ['incorrect_sleep'], feedback_text: 'Sleep shows 3h. Write to me at jane.doe@example.com or 9876543210',
  device_serial: 'R2N08250600302', client: { platform: 'ios', app_version: '2.6.0' }, ...over,
});

async function cleanup() {
  await app.db.query('delete from luna_feedback.submissions where user_id = any($1::bigint[])', [IDS]);
  await app.db.query('delete from luna_feedback.beta_users where user_id = any($1::bigint[])', [IDS]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%+${run}@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%+${run}@${DOMAIN}`]);
}

beforeAll(async () => {
  const imagekit = new ImageKitClient({ publicKey: 'public_test_key', privateKey: 'private_test_key', urlEndpoint: 'https://ik.imagekit.io/testacct', folder: '/luna-feedback-screenshots', fetchImpl: async () => new Response('{}') });
  app = buildApp({ config: cfg, logger: false, jira: null, imagekit, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('the beta key', () => {
  it('reaches the beta routes and the form schema, nothing else', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${OUTSIDER}`, headers: betaHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: betaHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema/sleep', headers: betaHeaders })).statusCode).toBe(200);
    for (const [method, url] of [['GET', '/v1/feedback'], ['GET', '/v1/feedback/stats'], ['GET', '/v1/uploads/screenshot-auth'], ['POST', '/v1/feedback/sleep'], ['GET', '/v1/admin/beta-users'], ['GET', '/v1/cx/feedback/LN-1']] as const) {
      const r = await app.inject({ method, url, headers: betaHeaders, payload: method === 'POST' ? betaBody(OUTSIDER) : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('is the only key the beta routes take, apart from the admin key', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${OUTSIDER}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${OUTSIDER}`, headers: appHeaders })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: appHeaders, payload: betaBody(OUTSIDER) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${OUTSIDER}`, headers: adminHeaders })).statusCode).toBe(200);
  });

  it('must differ from the other keys', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', BETA_API_KEY: cfg.APP_API_KEY })).toThrow(/BETA_API_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'test', BETA_API_KEY: cfg.ADMIN_API_KEY })).toThrow(/BETA_API_KEY/);
  });
});

describe('the beta list and the check', () => {
  it('says no, for a day, to someone not on the list', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/beta/users/${BETA_A}`, headers: betaHeaders });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user_id: BETA_A, is_beta: false, cache_seconds: 86400 });
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
  });

  it('refuses something that is not a user id', async () => {
    for (const bad of ['abc', '0', '-4', '1.5']) {
      const r = await app.inject({ method: 'GET', url: `/v1/beta/users/${bad}`, headers: betaHeaders });
      expect(r.statusCode, bad).toBe(422);
      expect(r.json().error.issues[0].path).toBe('user_id');
    }
  });

  it('adds ids from Settings, and the next check sees them at once despite the cache', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: { user_ids: [BETA_A, BETA_B, BETA_A] } });
    expect(r.statusCode).toBe(201);
    expect(r.json().added).toEqual([BETA_A, BETA_B].sort((a, b) => a - b));
    expect(r.json().already).toEqual([]);
    const again = await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: { user_ids: [BETA_B] } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ added: [], already: [BETA_B] });

    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${BETA_A}`, headers: betaHeaders })).json().is_beta).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${OUTSIDER}`, headers: betaHeaders })).json().is_beta).toBe(false);

    const list = (await app.inject({ method: 'GET', url: '/v1/admin/beta-users', headers: adminHeaders })).json();
    const row = list.items.find((x: { user_id: number }) => x.user_id === BETA_A);
    expect(row).toMatchObject({ user_id: BETA_A, added_by: 'admin_key', reports: 0 });
  });

  it('answers from memory: no database query per check', async () => {
    let queries = 0;
    const real = app.db.query.bind(app.db);
    (app.db as unknown as { query: unknown }).query = (...args: unknown[]) => { queries++; return (real as (...a: unknown[]) => unknown)(...args); };
    try {
      for (let i = 0; i < 20; i++) await app.inject({ method: 'GET', url: `/v1/beta/users/${i % 2 ? BETA_A : OUTSIDER}`, headers: betaHeaders });
    } finally { (app.db as unknown as { query: unknown }).query = real; }
    expect(queries).toBe(0);
  });

  it('refuses bad ids in Settings', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: { user_ids: [BETA_A, 'x'] } });
    expect(r.statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: { user_ids: [] } })).statusCode).toBe(422);
  });
});

let firstRef = '';
const first_ref = () => firstRef;

describe('a beta user\'s report', () => {
  let first: { id: string; ref: string } = { id: '', ref: '' };

  it('is refused for someone not on the list', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: betaHeaders, payload: betaBody(OUTSIDER) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('NOT_A_BETA_USER');
  });

  it('is stored as a production beta report, without the email, its text redacted', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: { ...betaHeaders, 'idempotency-key': `beta-${run}-1` }, payload: betaBody(BETA_A) });
    expect(r.statusCode).toBe(201);
    first = r.json();
    firstRef = first.ref;
    expect(Object.keys(r.json()).sort()).toEqual(['created_at', 'created_at_ist', 'feature_key', 'id', 'is_positive', 'occurred_on', 'ref', 'status']);
    expect(r.json().ref).toMatch(/^LN-\d{5,}$/);

    const dto = (await app.inject({ method: 'GET', url: `/v1/feedback/${first.ref}`, headers: adminHeaders })).json();
    expect(dto).toMatchObject({ origin: 'beta', environment: 'production', email: null, email_masked: 'so***@e***.com', user_id: BETA_A, submitted_via: 'app', device_serial: 'R2N08250600302', platform: 'ios' });
    const row = await app.db.query<{ j: string }>('select row_to_json(s)::text as j from luna_feedback.submissions s where id = $1', [dto.id]);
    expect(row.rows[0]!.j).not.toContain(`someone+${run}@example.com`);
    expect(dto.feedback_text).not.toContain('jane.doe@example.com');
    expect(dto.feedback_text).not.toContain('9876543210');
  });

  it('keeps an environment the app sends', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: betaHeaders, payload: betaBody(BETA_B, { client: { environment: 'Stage' }, email: undefined }) });
    expect(r.statusCode).toBe(201);
    const stored = (await app.inject({ method: 'GET', url: `/v1/feedback/${r.json().ref}`, headers: adminHeaders })).json();
    expect(stored).toMatchObject({ environment: 'stage', email_masked: null });
  });

  it('returns the same report for the same Idempotency-Key, and refuses the key for anyone else', async () => {
    const again = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: { ...betaHeaders, 'idempotency-key': `beta-${run}-1` }, payload: betaBody(BETA_A) });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
    const other = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: { ...betaHeaders, 'idempotency-key': `beta-${run}-1` }, payload: betaBody(BETA_B) });
    expect(other.statusCode).toBe(409);
  });

  it('refuses a sprint and unknown fields, and accepts positive feedback', async () => {
    const sprint = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: betaHeaders, payload: betaBody(BETA_A, { sprint: 'current' }) });
    expect(sprint.statusCode).toBe(422);
    expect(sprint.json().error.issues[0].path).toBe('sprint');
    expect((await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: betaHeaders, payload: betaBody(BETA_A, { origin: 'internal' }) })).statusCode).toBe(422);
    const fine = await app.inject({ method: 'POST', url: '/v1/beta/feedback/home', headers: betaHeaders, payload: { is_test: true, is_positive: true, user_id: BETA_A } });
    expect(fine.statusCode).toBe(201);
  });

  it('is listed under the beta source, and nowhere else', async () => {
    const beta = (await app.inject({ method: 'GET', url: `/v1/feedback?origin=beta&is_test=true&user_id=${BETA_A}`, headers: adminHeaders })).json();
    expect(beta.items.map((x: { id: string }) => x.id)).toContain(first.id);
    expect(beta.items.every((x: { origin: string }) => x.origin === 'beta')).toBe(true);
    const internal = (await app.inject({ method: 'GET', url: `/v1/feedback?origin=internal&is_test=true&user_id=${BETA_A}`, headers: adminHeaders })).json();
    expect(internal.items).toEqual([]);
    const home = await app.inject({ method: 'GET', url: `/v1/home/reports?origin=beta&user_id=${BETA_A}&data=test&view=all`, headers: adminHeaders });
    expect(home.statusCode).toBe(200);
    expect(home.json().items.length).toBeGreaterThan(0);
    expect(home.json().items.every((x: { origin: string }) => x.origin === 'beta')).toBe(true);
  });

  it('shows up on the attention, analytics and home pages without breaking them', async () => {
    const attention = await app.inject({ method: 'GET', url: '/v1/attention?is_test=true&origin=beta', headers: adminHeaders });
    expect(attention.statusCode).toBe(200);
    expect(attention.json().age_buckets.some((b: { origin: string; count: number }) => b.origin === 'beta' && b.count > 0)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/attention?is_test=true', headers: adminHeaders })).statusCode).toBe(200);
    const stats = await app.inject({ method: 'GET', url: '/v1/feedback/stats?is_test=true&from=2026-10-01&to=2026-10-31', headers: adminHeaders });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().by_origin.some((o: { origin: string }) => o.origin === 'beta')).toBe(true);
    const analytics = await app.inject({ method: 'GET', url: '/v1/analytics/overview?is_test=true&from=2026-10-01&to=2026-10-31', headers: adminHeaders });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().by_origin.some((o: { origin: string }) => o.origin === 'beta')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/analytics/overview?is_test=true&origin=beta&from=2026-10-01&to=2026-10-31', headers: adminHeaders })).statusCode).toBe(200);
    const home = await app.inject({ method: 'GET', url: '/v1/home', headers: adminHeaders });
    expect(home.statusCode).toBe(200);
    expect(home.json().summary.today).toHaveProperty('beta');
    expect((await app.inject({ method: 'GET', url: '/v1/admin/diagnoses/overview?origin=beta&include_test=true', headers: adminHeaders })).statusCode).toBe(200);
  });

  it('gets screenshot credentials only for users on the list', async () => {
    const no = await app.inject({ method: 'GET', url: `/v1/beta/uploads/screenshot-auth?user_id=${OUTSIDER}`, headers: betaHeaders });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.code).toBe('NOT_A_BETA_USER');
    const yes = await app.inject({ method: 'GET', url: `/v1/beta/uploads/screenshot-auth?user_id=${BETA_A}`, headers: betaHeaders });
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toMatchObject({ public_key: 'public_test_key', folder: '/luna-feedback-screenshots' });
    expect(yes.json().signature).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('names on the beta list', () => {
  // The blocks below expect OUTSIDER off the list again.
  afterAll(async () => { await app.inject({ method: 'POST', url: '/v1/admin/beta-users/remove', headers: adminHeaders, payload: { user_ids: [OUTSIDER] } }); });

  it('takes a name with an id, and renames an id already listed', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: {
      users: [{ user_id: BETA_A, name: '  Rahul, Strava group ' }, { user_id: OUTSIDER, name: '' }], user_ids: [BETA_B],
    } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ added: [OUTSIDER], renamed: [BETA_A], already: [BETA_B] });
    const items = (await app.inject({ method: 'GET', url: '/v1/admin/beta-users', headers: adminHeaders })).json().items as { user_id: number; name: string | null }[];
    expect(items.find((x) => x.user_id === BETA_A)?.name).toBe('Rahul, Strava group');
    expect(items.find((x) => x.user_id === OUTSIDER)?.name).toBeNull();
    // A bare id never wipes a name it already has.
    await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: { user_ids: [BETA_A] } });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/beta-users', headers: adminHeaders })).json().items.find((x: { user_id: number }) => x.user_id === BETA_A).name).toBe('Rahul, Strava group');
  });

  it('renames and clears one name, and refuses an id not on the list or a name too long', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/v1/admin/beta-users/${OUTSIDER}`, headers: adminHeaders, payload: { name: 'Asha (Garmin)' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user_id: OUTSIDER, name: 'Asha (Garmin)' });
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/beta-users/${OUTSIDER}`, headers: adminHeaders, payload: { name: '' } })).json().name).toBeNull();
    expect((await app.inject({ method: 'PATCH', url: '/v1/admin/beta-users/123', headers: adminHeaders, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/beta-users/${OUTSIDER}`, headers: adminHeaders, payload: { name: 'x'.repeat(121) } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: adminHeaders, payload: { users: [{ user_id: OUTSIDER, name: 'x'.repeat(121) }] } })).statusCode).toBe(422);
  });

  it('shows the name on their reports, and never to the app', async () => {
    const one = (await app.inject({ method: 'GET', url: `/v1/feedback/${first_ref()}`, headers: adminHeaders })).json();
    expect(one.beta_name).toBe('Rahul, Strava group');
    const list = (await app.inject({ method: 'GET', url: `/v1/feedback?origin=beta&is_test=true&user_id=${BETA_A}`, headers: adminHeaders })).json();
    expect(list.items[0].beta_name).toBe('Rahul, Strava group');
    const home = (await app.inject({ method: 'GET', url: `/v1/home/reports?origin=beta&user_id=${BETA_A}&data=test&view=all`, headers: adminHeaders })).json();
    expect(home.items.every((x: { beta_name: string | null }) => x.beta_name === 'Rahul, Strava group')).toBe(true);
    const check = (await app.inject({ method: 'GET', url: `/v1/beta/users/${BETA_A}`, headers: betaHeaders })).json();
    expect(check).toEqual({ user_id: BETA_A, is_beta: true, cache_seconds: 86400 });
    const filed = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: betaHeaders, payload: betaBody(BETA_A) });
    expect(JSON.stringify(filed.json())).not.toContain('Rahul');
  });

  it('a developer cannot rename', async () => {
    const email = `dev2+${run}@${DOMAIN}`;
    const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email, role: 'developer' } })).json().generated_password;
    const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email, password: pass } });
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/beta-users/${BETA_A}`, headers: { ...dash, cookie }, payload: { name: 'nope' } })).statusCode).toBe(403);
  });
});

describe('removing a beta user', () => {
  it('turns the check off and refuses their next report; their reports stay', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/beta-users/remove', headers: adminHeaders, payload: { user_ids: [BETA_A, OUTSIDER] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: [BETA_A], not_listed: [OUTSIDER] });
    expect((await app.inject({ method: 'GET', url: `/v1/beta/users/${BETA_A}`, headers: betaHeaders })).json().is_beta).toBe(false);
    const refused = await app.inject({ method: 'POST', url: '/v1/beta/feedback/sleep', headers: betaHeaders, payload: betaBody(BETA_A) });
    expect(refused.statusCode).toBe(403);
    const kept = (await app.inject({ method: 'GET', url: `/v1/feedback?origin=beta&is_test=true&user_id=${BETA_A}`, headers: adminHeaders })).json();
    expect(kept.items.length).toBeGreaterThan(0);
  });
});

describe('who may change the list', () => {
  it('QC may; a developer may look but not change it', async () => {
    const cookies: Record<string, string> = {};
    for (const role of ['qc', 'developer']) {
      const email = `${role}+${run}@${DOMAIN}`;
      const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email, role } })).json().generated_password;
      const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email, password: pass } });
      cookies[role] = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    }
    const dev = { ...dash, cookie: cookies.developer };
    expect((await app.inject({ method: 'GET', url: '/v1/admin/beta-users', headers: dev })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: dev, payload: { user_ids: [OUTSIDER] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/beta-users/remove', headers: dev, payload: { user_ids: [BETA_B] } })).statusCode).toBe(403);
    const qc = { ...dash, cookie: cookies.qc };
    const added = await app.inject({ method: 'POST', url: '/v1/admin/beta-users', headers: qc, payload: { user_ids: [OUTSIDER] } });
    expect(added.statusCode).toBe(201);
    const row = (await app.inject({ method: 'GET', url: '/v1/admin/beta-users', headers: qc })).json().items.find((x: { user_id: number }) => x.user_id === OUTSIDER);
    expect(row.added_by).toBe(`qc+${run}@${DOMAIN}`);
  });
});
