import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { ImageKitClient } from '../../src/modules/uploads/imagekit.js';

/**
 * Screenshots added to a report after it was filed, from its page on the dashboard: up to the five a
 * report holds, recorded in its history, and removable by whoever added them (or QC). The reporter's
 * own screenshots stay.
 */
const DOMAIN = 'luna-shots-test.invalid';
const run = `${Date.now()}`;
const email = (who: string) => `${who}+${run}@${DOMAIN}`;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', IMAGEKIT_PUB_KEY: 'public_test_key', IMAGEKIT_PRI_KEY: 'private_test_key', IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/testacct' });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

const deleted: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => { if (init?.method === 'DELETE') deleted.push(String(input).split('/').pop()!); return new Response('', { status: 204 }); };
const shot = (n: string) => ({ file_id: `${n}_${run}`, url: `https://ik.imagekit.io/testacct/luna-feedback-screenshots/${n}_${run}.jpg`, name: `${n}.jpg`, width: 739, height: 1600, size: 74_000, upload_size: 310_000, original_width: 1170, original_height: 2532 });

const cookies: Record<string, string> = {};
async function account(who: string, role: string) {
  const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email(who), role, name: who } })).json().generated_password;
  const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email(who), password: pass } });
  cookies[who] = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}
const as = (who: string) => ({ ...dash, cookie: cookies[who]! });
const add = (id: string, shots: unknown[], who = 'dev') => app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/screenshots`, headers: as(who), payload: { screenshots: shots } });
const remove = (id: string, fileId: string, who = 'dev') => app.inject({ method: 'DELETE', url: `/v1/admin/submissions/${id}/screenshots/${encodeURIComponent(fileId)}`, headers: as(who) });
const ids = (r: { screenshots: { file_id: string }[] }) => r.screenshots.map((s) => s.file_id.replace(`_${run}`, ''));

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

let report: { id: string; ref: string };

beforeAll(async () => {
  const imagekit = new ImageKitClient({ publicKey: 'public_test_key', privateKey: 'private_test_key', urlEndpoint: 'https://ik.imagekit.io/testacct', folder: '/luna-feedback-screenshots', fetchImpl: fakeFetch });
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null }, imagekit });
  await app.ready();
  await cleanup();
  await account('qc', 'qc');
  await account('dev', 'developer');
  await account('dev2', 'developer');
  await account('biz', 'business');
  const r = await app.inject({
    method: 'POST', url: '/v1/feedback/home', headers: appHeaders,
    payload: { is_test: true, is_positive: false, occurred_on: '2026-10-10', user_id: 900555, email: email('tester'), issue_categories: ['wrong_peak_score'], feedback_text: `screenshots test ${run}`, screenshots: [shot('sent')] },
  });
  expect(r.statusCode).toBe(201);
  report = r.json();
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('adding screenshots to a filed report', () => {
  it('adds them with who and when, skips files it already holds, and records it', async () => {
    const r = await add(report.id, [shot('a'), shot('b'), shot('a')]);
    expect(r.statusCode).toBe(201);
    const dto = r.json();
    expect(ids(dto)).toEqual(['sent', 'a', 'b']);
    expect(dto.screenshots[0].added_by).toBeUndefined();
    expect(dto.screenshots[1]).toEqual({ ...shot('a'), thumbnail_url: null, added_by: email('dev'), added_at: expect.any(String) });
    // By reference too, and the same file again changes nothing.
    expect(ids((await add(report.ref, [shot('b')])).json())).toEqual(['sent', 'a', 'b']);

    const history = (await app.inject({ method: 'GET', url: `/v1/feedback/${report.id}/activity`, headers: adminHeaders })).json().items;
    const events = history.filter((e: { action: string }) => e.action === 'screenshot');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: email('dev'), from_value: '1', to_value: '3' });
  });

  it('holds five at most', async () => {
    const over = await add(report.id, [shot('c'), shot('d'), shot('e')]);
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toContain('2 more fit');
    expect((await add(report.id, [shot('c'), shot('d')], 'qc')).statusCode).toBe(201);
    const full = await add(report.id, [shot('e')]);
    expect(full.statusCode).toBe(409);
    expect(full.json().error.message).toContain('already has 5 screenshots');
    expect((await add(report.id, [1, 2, 3, 4, 5, 6].map((i) => shot(`x${i}`)))).statusCode).toBe(422);
  });

  it('refuses read-only roles, other hosts, and reports that do not exist', async () => {
    expect((await add(report.id, [shot('z')], 'biz')).statusCode).toBe(403);
    const evil = await add(report.id, [{ file_id: 'evil', url: 'https://evil.example.com/x.png' }]);
    expect(evil.statusCode).toBe(422);
    expect(evil.json().error.issues[0].path).toBe('screenshots.0.url');
    expect((await add(report.id, [])).statusCode).toBe(422);
    expect((await add('LN-99999999', [shot('z')])).statusCode).toBe(404);
  });
});

describe('removing an added screenshot', () => {
  it('lets whoever added it, or QC, remove it and deletes the image; the reporter\'s stays', async () => {
    expect((await remove(report.id, shot('a').file_id, 'dev2')).statusCode).toBe(403);
    expect((await remove(report.id, shot('a').file_id, 'biz')).statusCode).toBe(403);
    expect((await remove(report.id, shot('sent').file_id, 'qc')).statusCode).toBe(409);
    expect((await remove(report.id, 'not-there', 'qc')).statusCode).toBe(404);

    const mine = await remove(report.id, shot('a').file_id, 'dev');
    expect(mine.statusCode).toBe(200);
    expect(ids(mine.json())).toEqual(['sent', 'b', 'c', 'd']);
    const theirs = await remove(report.id, shot('b').file_id, 'qc');
    expect(ids(theirs.json())).toEqual(['sent', 'c', 'd']);
    expect(deleted).toEqual([shot('a').file_id, shot('b').file_id]);

    const history = (await app.inject({ method: 'GET', url: `/v1/feedback/${report.id}/activity`, headers: adminHeaders })).json().items;
    expect(history.filter((e: { action: string }) => e.action === 'screenshot').at(-1)).toMatchObject({ actor: email('qc'), from_value: '4', to_value: '3' });
  });
});

describe('without ImageKit', () => {
  it('says uploads are not set up', async () => {
    const bare = buildApp({ config: cfg, logger: false, db: app.db, jira: null, diagnosis: { logs: null, ai: null }, imagekit: null });
    await bare.ready();
    const r = await bare.inject({ method: 'POST', url: `/v1/admin/submissions/${report.id}/screenshots`, headers: adminHeaders, payload: { screenshots: [shot('q')] } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.issues[0].message).toContain('not configured');
    await bare.close();
  });
});
