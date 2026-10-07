import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';

/**
 * The dashboard's Report page: a signed-in person posts to the same endpoint as the app, and the
 * report is recorded as filed from the dashboard, by them.
 */
const DOMAIN = 'luna-report-test.invalid';
const run = `${Date.now()}`;
const email = (who: string) => `${who}+${run}@${DOMAIN}`;
const PASSWORD = 'Report-page-pass-42';

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', IMAGEKIT_PUB_KEY: 'public_test_key', IMAGEKIT_PRI_KEY: 'private_test_key', IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/testacct' });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };
const SHOT = 'https://ik.imagekit.io/testacct/luna-feedback-screenshots/report_abc123.jpg';

const body = (over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-10-01', user_id: 900777, email: email('luna'),
  issue_categories: ['wrong_peak_score'], feedback_text: 'posted from the dashboard', ...over,
});

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

let cookie = '';
const asUser = () => ({ ...dash, cookie });

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, diagnosis: { logs: null, ai: null }, jira: null });
  await app.ready();
  await cleanup();
  // A business account: read-only everywhere else, which is the point — anyone signed in can file.
  const made = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email('biz'), role: 'business', name: 'Business Person', password: PASSWORD } });
  expect(made.statusCode).toBe(201);
  const res = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email('biz'), password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '';
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('posting a report from the dashboard', () => {
  it('serves the page, and a session can read the form schema and the upload credentials', async () => {
    const page = await app.inject({ method: 'GET', url: '/dashboard/report' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Report an issue');

    const schema = await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: asUser() });
    expect(schema.statusCode).toBe(200);
    expect(schema.json().uploads.screenshots.enabled).toBe(true);

    const auth = await app.inject({ method: 'GET', url: '/v1/uploads/screenshot-auth', headers: asUser() });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().public_key).toBe('public_test_key');
  });

  it('a read-only role can file; the report says it came from the dashboard and the history names them', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/feedback/home', headers: { ...asUser(), 'idempotency-key': `dash-${run}` },
      payload: body({
        client: { environment: 'production', platform: 'ios', app_version: '2.4.0' },
        screenshots: [{ file_id: 'f_dash', url: SHOT, name: 'home.jpg', width: 739, height: 1600, size: 74000, upload_size: 320000, original_width: 1170, original_height: 2532 }],
      }),
    });
    expect(r.statusCode).toBe(201);
    const dto = r.json();
    expect(dto).toMatchObject({ origin: 'internal', submitted_via: 'dashboard', environment: 'production', platform: 'ios', email: email('luna') });
    expect(dto.screenshots).toHaveLength(1);

    const history = await app.inject({ method: 'GET', url: `/v1/feedback/${dto.id}/activity`, headers: asUser() });
    expect(history.statusCode).toBe(200);
    const created = history.json().items.find((e: { action: string }) => e.action === 'created');
    expect(created).toMatchObject({ actor: email('biz'), to_value: 'internal' });

    // A double-click: the same key returns the first report instead of a second one.
    const again = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: { ...asUser(), 'idempotency-key': `dash-${run}` }, payload: body() });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(dto.id);
  });

  it('lists name the tester: the dashboard account with that email, else the part before @', async () => {
    // The reporter's Luna email is their dashboard email too, so the list can show "Business Person".
    const named = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: asUser(), payload: body({ email: email('biz').toUpperCase(), user_id: 900778 }) });
    expect(named.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: `/v1/feedback?ref=${named.json().ref}`, headers: asUser() });
    expect(list.json().items[0]).toMatchObject({ user_id: 900778, tester_name: 'Business Person' });
    const home = await app.inject({ method: 'GET', url: '/v1/home/reports?view=all&data=test&user_id=900778', headers: asUser() });
    expect(home.statusCode).toBe(200);
    // The email is kept as sent; the account lookup ignores case.
    expect(home.json().items[0]).toMatchObject({ user_id: 900778, email: email('biz').toUpperCase(), tester_name: 'Business Person' });

    // No account for the email: the pages fall back to its local part, so the API only says there is no name.
    const unnamed = await app.inject({ method: 'GET', url: '/v1/home/reports?view=all&data=test&user_id=900777', headers: asUser() });
    expect(unnamed.json().items[0]).toMatchObject({ user_id: 900777, email: email('luna'), tester_name: null });
  });

  it('remembers who you are on the account, editable and merged key by key', async () => {
    const first = await app.inject({ method: 'PATCH', url: '/v1/me/reporter', headers: asUser(), payload: { user_id: 900778, email: email('biz'), platform: 'ios' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().reporter_profile).toEqual({ user_id: 900778, email: email('biz'), platform: 'ios' });

    // A later change touches only the keys sent; null removes one; '' counts as null.
    const second = await app.inject({ method: 'PATCH', url: '/v1/me/reporter', headers: asUser(), payload: { user_id: 900779, platform: null, app_version: '' } });
    expect(second.json().reporter_profile).toEqual({ user_id: 900779, email: email('biz') });

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: asUser() });
    expect(me.json().reporter_profile).toEqual({ user_id: 900779, email: email('biz') });

    expect((await app.inject({ method: 'PATCH', url: '/v1/me/reporter', headers: asUser(), payload: { user_id: -1 } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: '/v1/me/reporter', headers: asUser(), payload: { nickname: 'x' } })).statusCode).toBe(422);
  });

  it('validates per field, the same as for the app', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: asUser(), payload: body({ issue_categories: [], details: { actual_start_time: '11:30 PM', actual_end_time: '11:30 PM' } }) });
    expect(r.statusCode).toBe(422);
    const paths = r.json().error.issues.map((i: { path: string }) => i.path);
    expect(paths).toContain('issue_categories');
    expect(paths).toContain('details.actual_end_time');
  });

  it('the app key still files as the app', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() });
    expect(r.statusCode).toBe(201);
    expect(r.json().submitted_via).toBe('app');
    const history = await app.inject({ method: 'GET', url: `/v1/feedback/${r.json().id}/activity`, headers: adminHeaders });
    expect(history.json().items.find((e: { action: string }) => e.action === 'created').actor).toBe('app');
  });
});
