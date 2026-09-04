import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';

const TEST_EMAIL_DOMAIN = 'luna-test.invalid';
const TEST_CATEGORY = 'zz_test_category';
const run = `${Date.now()}`;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent' });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };

const validBody = (over: Record<string, unknown> = {}) => ({
  is_test: true,
  is_positive: false,
  occurred_on: '2026-09-01',
  user_id: 900001,
  email: `tester+${run}@${TEST_EMAIL_DOMAIN}`,
  issue_categories: ['wrong_peak_score'],
  feedback_text: 'integration test',
  ...over,
});

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${TEST_EMAIL_DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.issue_categories where key = $1`, [TEST_CATEGORY]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, diagnosis: { logs: null, ai: null } });
  await app.ready();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('health & auth', () => {
  it('healthz is open and reports db up', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: 'up' });
  });

  it('rejects missing and wrong app keys', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: { 'x-api-key': 'nope' } })).statusCode).toBe(401);
  });

  it('app key cannot reach admin routes; admin key can reach both', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/admin/features', headers: appHeaders })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/features', headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: adminHeaders })).statusCode).toBe(200);
  });

  it('unknown routes return the error envelope', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/nope', headers: appHeaders });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/feedback/schema', () => {
  it('returns all four features with seeded categories and registry fields', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.schema_version).toBe(1);
    expect(body.features.map((f: { key: string }) => f.key)).toEqual(['home', 'sleep', 'activity', 'workout', 'other']);
    const counts = Object.fromEntries(body.features.map((f: { key: string; issue_categories: unknown[] }) => [f.key, f.issue_categories.length]));
    expect(counts).toEqual({ home: 3, sleep: 4, activity: 5, workout: 8, other: 9 });
    const sleep = body.features.find((f: { key: string }) => f.key === 'sleep');
    expect(sleep.fields.map((f: { key: string }) => f.key)).toEqual(['actual_start_time', 'actual_end_time', 'recorded_start_time', 'recorded_end_time']);
    expect(sleep.rules).toHaveLength(2);
    expect(body.common_fields.find((f: { key: string }) => f.key === 'feedback_text').maxLength).toBe(500);
    expect(body.common_fields.find((f: { key: string }) => f.key === 'device_serial')).toMatchObject({ type: 'string', required: false, maxLength: 64 });
    expect(body.client_context_keys).toContain('platform');
    expect(body.client_context_fields.find((f: { key: string }) => f.key === 'platform').options).toEqual(['ios', 'android']);
  });

  it('supports ETag / 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\//);
    const second = await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: { ...appHeaders, 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
  });

  it('serves a single feature and 404s unknown ones', async () => {
    const ok = await app.inject({ method: 'GET', url: '/v1/feedback/schema/home', headers: appHeaders });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().fields[0].key).toBe('peak_score_value');
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/schema/nutrition', headers: appHeaders })).statusCode).toBe(404);
  });
});

describe('POST /v1/feedback/:feature', () => {
  it('stores a home submission and returns IST timestamp', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback/home', headers: appHeaders,
      payload: validBody({ device_serial: 'R2N08250600302', details: { peak_score_value: 87 }, client: { platform: 'iOS', app_version: '2.4.0', build_channel: 'stage', firmware_version: '1.9.2' } }),
    });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.platform).toBe('ios');
    expect(b.device_serial).toBe('R2N08250600302');
    expect(b.is_test).toBe(true);
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.feature_key).toBe('home');
    expect(b.user_id).toBe(900001);
    expect(b.occurred_on).toBe('2026-09-01');
    expect(b.details).toEqual({ peak_score_value: 87 });
    expect(b.app_version).toBe('2.4.0');
    expect(b.firmware_version).toBe('1.9.2');
    expect(b.created_at).toMatch(/Z$/);
    expect(b.created_at_ist).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+05:30$/);
    expect(b).not.toHaveProperty('idempotency_key');
  });

  it('stores sleep with normalised times', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders,
      payload: validBody({ issue_categories: ['incorrect_sleep', 'vitals_not_recorded'], details: { actual_start_time: '11:30 pm', recorded_end_time: '5:00 AM' } }),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().details).toEqual({ actual_start_time: '11:30 PM', recorded_end_time: '05:00 AM' });
  });

  it('accepts positive feedback without categories or date, defaulting the date to today (IST)', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders,
      payload: { is_test: true, is_positive: true, user_id: 900001, email: `tester+${run}@${TEST_EMAIL_DOMAIN}`, feedback_text: 'All good' } });
    expect(r.statusCode).toBe(201);
    expect(r.json().issue_categories).toEqual([]);
    expect(r.json().occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const neg = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders,
      payload: { is_test: true, is_positive: false, user_id: 900001, email: `tester+${run}@${TEST_EMAIL_DOMAIN}` } });
    expect(neg.statusCode).toBe(422);
    expect(neg.json().error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['issue_categories', 'occurred_on']);
    const schema = (await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders })).json();
    expect(schema.common_fields.find((f: { key: string }) => f.key === 'issue_categories').requiredIf).toEqual({ field: 'is_positive', equals: false });
  });

  it('stores an "other" submission with the screen field', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/other', headers: appHeaders,
      payload: validBody({ issue_categories: ['app_crash', 'something_else'], details: { screen: 'Settings > Profile' } }) });
    expect(r.statusCode).toBe(201);
    expect(r.json().details).toEqual({ screen: 'Settings > Profile' });
    expect((await app.inject({ method: 'POST', url: '/v1/feedback/other', headers: appHeaders, payload: validBody({ issue_categories: ['wrong_peak_score'] }) })).statusCode).toBe(422);
  });

  it('stores activity and workout', async () => {
    const a = await app.inject({ method: 'POST', url: '/v1/feedback/activity', headers: appHeaders,
      payload: validBody({ issue_categories: ['incorrect_steps'], details: { steps: 8000, total_calories: 2100 } }) });
    expect(a.statusCode).toBe(201);
    const w = await app.inject({ method: 'POST', url: '/v1/feedback/workout', headers: appHeaders,
      payload: validBody({ issue_categories: ['hr_not_showing', 'end_workout_fail'], details: { workout_type: 'Run', intensity: 'high', start_time: '6:00 AM', end_time: '6:45 AM' } }) });
    expect(w.statusCode).toBe(201);
  });

  it('returns 422 with field-level issues', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback/home', headers: appHeaders,
      payload: validBody({ issue_categories: ['incorrect_sleep'], details: { peak_score_value: 250 }, feedback_text: 'x'.repeat(501) }),
    });
    expect(r.statusCode).toBe(422);
    const issues = r.json().error.issues.map((i: { path: string }) => i.path).sort();
    expect(issues).toEqual(['details.peak_score_value', 'feedback_text', 'issue_categories.0']);
  });

  it('404s for unknown features and 400s malformed JSON', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/feedback/nutrition', headers: appHeaders, payload: validBody() })).statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('honours Idempotency-Key on replay', async () => {
    const headers = { ...appHeaders, 'idempotency-key': `test-${run}` };
    const first = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers, payload: validBody() });
    const second = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers, payload: validBody() });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });
});

describe('GET /v1/feedback', () => {
  it('lists with filters and paginates by cursor', async () => {
    const email = `tester+${run}@${TEST_EMAIL_DOMAIN}`;
    const all = await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&limit=2`, headers: appHeaders });
    expect(all.statusCode).toBe(200);
    const page1 = all.json();
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    expect(page1.items.every((i: { email: string }) => i.email === email)).toBe(true);

    const page2 = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, headers: appHeaders })).json();
    expect(page2.items[0].id).not.toBe(page1.items[0].id);

    const sleepOnly = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&feature=sleep`, headers: appHeaders })).json();
    expect(sleepOnly.items).toHaveLength(1);
    const byCat = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&category=end_workout_fail`, headers: appHeaders })).json();
    expect(byCat.items).toHaveLength(1);
    expect(byCat.items[0].feature_key).toBe('workout');
    const real = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&is_test=false`, headers: appHeaders })).json();
    expect(real.items).toHaveLength(0);
    const ios = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&platform=ios`, headers: appHeaders })).json();
    expect(ios.items).toHaveLength(1);
    expect(ios.items[0].feature_key).toBe('home');
    expect((await app.inject({ method: 'GET', url: `/v1/feedback?platform=web`, headers: appHeaders })).statusCode).toBe(422);
  });

  it('fetches one by id and 404s on missing', async () => {
    const list = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900001&limit=1`, headers: appHeaders })).json();
    const id = list.items[0].id;
    expect((await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: appHeaders })).json().id).toBe(id);
    expect((await app.inject({ method: 'GET', url: `/v1/feedback/00000000-0000-0000-0000-000000000000`, headers: appHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/feedback/not-a-uuid`, headers: appHeaders })).statusCode).toBe(404);
  });

  it('rejects bad query params', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/feedback?from=2026-02-30`, headers: appHeaders })).statusCode).toBe(422);
  });
});

describe('GET /v1/feedback/stats', () => {
  it('aggregates the same slice as the list', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/feedback/stats?user_id=900001&from=2026-09-01&to=2026-09-01', headers: appHeaders });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.range).toEqual({ from: '2026-09-01', to: '2026-09-01' });
    expect(b.totals.submissions).toBeGreaterThanOrEqual(5);
    expect(b.totals.negative).toBe(b.totals.submissions);
    expect(b.totals.users).toBe(1);
    expect(b.by_day).toEqual([{ date: '2026-09-01', positive: 0, negative: b.totals.submissions }]);
    expect(b.by_feature.map((f: { feature_key: string }) => f.feature_key)).toEqual(['home', 'sleep', 'activity', 'workout', 'other']);
    expect(b.by_feature.find((f: { feature_key: string }) => f.feature_key === 'sleep').negative).toBe(1);
    const cat = b.by_category.find((c: { key: string }) => c.key === 'end_workout_fail');
    expect(cat).toMatchObject({ feature_key: 'workout', label: 'End workout fail', count: 1 });
  });

  it('defaults to the last 30 days and rejects inverted ranges', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/feedback/stats', headers: appHeaders });
    expect(r.statusCode).toBe(200);
    const { from, to } = r.json().range;
    expect(to >= from).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/stats?from=2026-09-02&to=2026-09-01', headers: appHeaders })).statusCode).toBe(422);
  });
});

describe('admin: test data', () => {
  it('counts flagged rows and refuses to delete without confirmation', async () => {
    const c = await app.inject({ method: 'GET', url: '/v1/admin/test-data', headers: adminHeaders });
    expect(c.statusCode).toBe(200);
    expect(c.json().count).toBeGreaterThanOrEqual(4);
    const adm = { 'x-admin-key': cfg.ADMIN_API_KEY };
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/test-data', headers: adm })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/test-data?confirm=delete', headers: { 'x-api-key': cfg.APP_API_KEY } })).statusCode).toBe(401);
  });
});

describe('dashboard session', () => {
  const dh = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };
  let cookie = '';

  it('rejects a wrong key and a missing header', async () => {
    expect((await app.inject({ method: 'POST', url: '/dashboard/login', headers: dh, payload: { key: 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/dashboard/login', headers: { 'content-type': 'application/json' }, payload: { key: cfg.DASHBOARD_KEY } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/dashboard/session' })).json()).toEqual({ authenticated: false });
  });

  it('issues an HttpOnly cookie for the right key', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dh, payload: { key: cfg.DASHBOARD_KEY } });
    expect(r.statusCode).toBe(200);
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/^luna_dash=/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    cookie = sc.split(';')[0]!;
    const s = await app.inject({ method: 'GET', url: '/dashboard/session', headers: { cookie } });
    expect(s.json().authenticated).toBe(true);
    expect(new Date(s.json().expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('cookie + header reaches data and admin routes; cookie alone does not', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/stats', headers: { cookie, 'x-requested-with': 'dashboard' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/features', headers: { cookie, 'x-requested-with': 'dashboard' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/stats', headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/feedback/stats', headers: { cookie: 'luna_dash=123.forged', 'x-requested-with': 'dashboard' } })).statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/logout', headers: { 'x-requested-with': 'dashboard', cookie } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });
});

describe('pages', () => {
  it('serves docs and dashboard without a key, redirects root', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toMatch(/text\/html/);
    expect(docs.body).toContain('Luna Feedback API');
    const dash = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dash.statusCode).toBe(200);
    expect(dash.body).toContain('Feedback Dashboard');
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/docs');
  });
});

describe('admin: issue categories', () => {
  let createdId: string;

  it('adds a category and the schema + validator pick it up', async () => {
    const create = await app.inject({ method: 'POST', url: '/v1/admin/features/home/issue-categories', headers: adminHeaders,
      payload: { key: TEST_CATEGORY, label: 'Test category', sort_order: 99 } });
    expect(create.statusCode).toBe(201);
    createdId = create.json().id;

    const schema = (await app.inject({ method: 'GET', url: '/v1/feedback/schema/home', headers: appHeaders })).json();
    expect(schema.issue_categories.map((c: { key: string }) => c.key)).toContain(TEST_CATEGORY);

    const post = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: validBody({ issue_categories: [TEST_CATEGORY] }) });
    expect(post.statusCode).toBe(201);
  });

  it('rejects duplicates and bad slugs', async () => {
    const dup = await app.inject({ method: 'POST', url: '/v1/admin/features/home/issue-categories', headers: adminHeaders, payload: { key: TEST_CATEGORY, label: 'Again' } });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/v1/admin/features/home/issue-categories', headers: adminHeaders, payload: { key: 'Bad Key', label: 'x' } });
    expect(bad.statusCode).toBe(422);
  });

  it('deactivating hides it from the schema and rejects new submissions', async () => {
    const patch = await app.inject({ method: 'PATCH', url: `/v1/admin/issue-categories/${createdId}`, headers: adminHeaders, payload: { is_active: false, label: 'Renamed' } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().is_active).toBe(false);
    expect(patch.json().label).toBe('Renamed');

    const schema = (await app.inject({ method: 'GET', url: '/v1/feedback/schema/home', headers: appHeaders })).json();
    expect(schema.issue_categories.map((c: { key: string }) => c.key)).not.toContain(TEST_CATEGORY);

    const post = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: validBody({ issue_categories: [TEST_CATEGORY] }) });
    expect(post.statusCode).toBe(422);

    const all = (await app.inject({ method: 'GET', url: '/v1/admin/features/home/issue-categories', headers: adminHeaders })).json();
    expect(all.items.find((c: { id: string }) => c.id === createdId).is_active).toBe(false);
  });

  it('feature patch round-trips', async () => {
    const off = await app.inject({ method: 'PATCH', url: '/v1/admin/features/workout', headers: adminHeaders, payload: { is_active: false } });
    expect(off.json().is_active).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/feedback/workout', headers: appHeaders, payload: validBody({ issue_categories: ['hr_not_showing'] }) })).statusCode).toBe(404);
    const on = await app.inject({ method: 'PATCH', url: '/v1/admin/features/workout', headers: adminHeaders, payload: { is_active: true } });
    expect(on.json().is_active).toBe(true);
  });
});
