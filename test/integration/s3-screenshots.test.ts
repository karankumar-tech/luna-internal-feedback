import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { ImageKitClient } from '../../src/modules/uploads/imagekit.js';
import { S3ScreenshotStore } from '../../src/modules/uploads/s3.js';

/**
 * New screenshots in S3, older ones on ImageKit: the upload link, the report holding either kind,
 * the open link that redirects to a signed GET, and deletes reaching the right store.
 */
const DOMAIN = 'luna-s3-test.invalid';
const run = `${Date.now()}`;
const email = (who: string) => `${who}+${run}@${DOMAIN}`;
const BASE = 'https://pulse.lunazone.com';

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', PUBLIC_BASE_URL: BASE });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };

const deleted: string[] = [];
const clientOptions = { credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret' } };
const s3 = new (class extends S3ScreenshotStore {
  override async deleteFile(id: string) { deleted.push(`s3:${id}`); return true; }
})({ bucket: 'pulse-shots', publicBaseUrl: BASE, region: 'ap-south-1', clientOptions });
const imagekit = new ImageKitClient({
  publicKey: 'public_test_key', privateKey: 'private_test_key', urlEndpoint: 'https://ik.imagekit.io/testacct', folder: '/luna-feedback-screenshots',
  fetchImpl: async (input, init) => { if (init?.method === 'DELETE') deleted.push(`ik:${String(input).split('/').pop()}`); return new Response('', { status: 204 }); },
});
const oldShot = { file_id: `old_${run}`, url: `https://ik.imagekit.io/testacct/luna-feedback-screenshots/old_${run}.jpg`, name: 'old.jpg' };

const report = (screenshots: unknown[]) => app.inject({
  method: 'POST', url: '/v1/feedback/home', headers: appHeaders,
  payload: { is_test: true, is_positive: false, occurred_on: '2026-10-28', user_id: 900777, email: email('tester'), issue_categories: ['wrong_peak_score'], feedback_text: `s3 test ${run}`, screenshots },
});
const link = (headers: Record<string, string>, body: unknown) => app.inject({ method: 'POST', url: '/v1/uploads/screenshot-url', headers, payload: body });

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: null }, imagekit, s3 });
  await app.ready();
});
afterAll(async () => {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
  await app.close();
});

describe('S3 uploads', () => {
  it('the schema points new uploads at S3 and keeps the ImageKit fields for older builds', async () => {
    const shots = (await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders })).json().uploads.screenshots;
    expect(shots).toMatchObject({ enabled: true, storage: 's3', upload_endpoint: '/v1/uploads/screenshot-url', auth_endpoint: '/v1/uploads/screenshot-auth', max_count: 5 });
  });

  it('hands out an upload link to the app and CX keys, checking type and size', async () => {
    const r = await link(appHeaders, { content_type: 'image/jpeg', size: 318_204 });
    expect(r.statusCode).toBe(200);
    const t = r.json();
    expect(t).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/jpeg' }, expires_in: 600, max_bytes: cfg.SCREENSHOT_MAX_BYTES });
    expect(t.url).toBe(`${BASE}/v1/screenshots/${t.file_id}`);
    expect(new URL(t.upload_url).host).toBe('pulse-shots.s3.ap-south-1.amazonaws.com');

    expect((await link({ 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' }, { content_type: 'image/png', size: 1000 })).statusCode).toBe(200);
    expect((await link(appHeaders, { content_type: 'image/gif', size: 1000 })).statusCode).toBe(422);
    expect((await link(appHeaders, { content_type: 'image/jpeg', size: cfg.SCREENSHOT_MAX_BYTES + 1 })).statusCode).toBe(422);
    expect((await link({ 'content-type': 'application/json' }, { content_type: 'image/jpeg', size: 1000 })).statusCode).toBe(401);
  });

  it('a report holds S3 and ImageKit screenshots side by side, and refuses links from elsewhere', async () => {
    const t = (await link(appHeaders, { content_type: 'image/jpeg', size: 1000 })).json();
    const r = await report([{ file_id: t.file_id, url: t.url, name: 'new.jpg' }, oldShot]);
    expect(r.statusCode).toBe(201);
    const dto = (await app.inject({ method: 'GET', url: `/v1/feedback/${r.json().id}`, headers: adminHeaders })).json();
    expect(dto.screenshots.map((s: { url: string }) => s.url)).toEqual([t.url, oldShot.url]);

    const forged = await report([{ file_id: t.file_id, url: `https://evil.example/v1/screenshots/${t.file_id}` }]);
    expect(forged.statusCode).toBe(422);
  });

  it('a screenshot link is open and redirects to a signed GET; anything else is not found', async () => {
    const id = 's3-7f0c2b1e-1111-4222-8333-444455556666';
    const r = await app.inject({ method: 'GET', url: `/v1/screenshots/${id}?tr=w-320` });
    expect(r.statusCode).toBe(302);
    const to = new URL(String(r.headers.location));
    expect(to.host).toBe('pulse-shots.s3.ap-south-1.amazonaws.com');
    expect(to.pathname).toBe('/screenshots/7f0c2b1e-1111-4222-8333-444455556666');
    expect(to.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(r.headers['cache-control']).toBe('private, max-age=3000');
    expect((await app.inject({ method: 'GET', url: '/v1/screenshots/not-an-id' })).statusCode).toBe(404);
  });

  it('deleting test data deletes each file from the store that holds it', async () => {
    const t = (await link(appHeaders, { content_type: 'image/jpeg', size: 1000 })).json();
    expect((await report([{ file_id: t.file_id, url: t.url }, { ...oldShot, file_id: `old2_${run}` }])).statusCode).toBe(201);
    deleted.length = 0;
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/test-data?confirm=delete', headers: adminHeaders })).statusCode).toBe(200);
    expect(deleted).toEqual(expect.arrayContaining([`s3:${t.file_id}`, `ik:old2_${run}`]));
  });

  it('the beta route checks the user before handing out a link', async () => {
    const beta = { 'x-api-key': cfg.BETA_API_KEY!, 'content-type': 'application/json' };
    const r = await app.inject({ method: 'POST', url: '/v1/beta/uploads/screenshot-url', headers: beta, payload: { user_id: 987654321, content_type: 'image/jpeg', size: 1000 } });
    expect(r.statusCode).toBe(403);
  });
});

describe('S3 only (no ImageKit keys)', () => {
  it('advertises S3 alone and says the ImageKit route is not set up', async () => {
    const only = buildApp({ config: cfg, logger: false, db: app.db, jira: null, diagnosis: { logs: null, ai: null }, imagekit: null, s3 });
    await only.ready();
    try {
      const shots = (await only.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders })).json().uploads.screenshots;
      expect(shots.storage).toBe('s3');
      expect(shots.auth_endpoint).toBeUndefined();
      const ik = await only.inject({ method: 'GET', url: '/v1/uploads/screenshot-auth', headers: appHeaders });
      expect(ik.statusCode).toBe(422);
      expect(ik.json().error.issues[0].message).toContain('/v1/uploads/screenshot-url');
    } finally { await only.close(); }
  });
});
