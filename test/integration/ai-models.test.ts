import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';
import { OpenRouterCatalog, toModelInfo } from '../../src/modules/diagnosis/ai/models.js';

/**
 * Settings → AI models: which OpenRouter models diagnose and chat. OpenRouter's model list is a
 * fake; the choice is stored in the real database, and whatever was there before is put back.
 */
const DOMAIN = 'luna-test.invalid';
const run = `${Date.now()}`;
const DEFAULT = 'google/gemini-3.1-flash-lite';
const model = (id: string, o: { images?: boolean; structured?: boolean; out?: string[]; prompt?: string; completion?: string; expires?: string } = {}) => ({
  id, name: `Test: ${id}`, context_length: 128_000, expiration_date: o.expires ?? null,
  architecture: { input_modalities: o.images === false ? ['text'] : ['text', 'image'], output_modalities: o.out ?? ['text'] },
  pricing: { prompt: o.prompt ?? '0.000001', completion: o.completion ?? '0.000004' },
  supported_parameters: o.structured === false ? ['response_format', 'temperature'] : ['response_format', 'structured_outputs', 'temperature'],
});
const LIST = [
  model(DEFAULT),
  model('test/vision-json'),
  model('test/text-json', { images: false }),
  model('test/prose', { structured: false }),
  model('test/painter', { out: ['image'] }),
];
let catalogUp = true;
let catalogCalls = 0;
const fakeCatalog: typeof fetch = async () => {
  catalogCalls += 1;
  return catalogUp ? new Response(JSON.stringify({ data: LIST }), { status: 200 }) : new Response('down', { status: 503 });
};

const cfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', CATEGORY_CACHE_TTL_MS: '0' });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

let app: App;
let held: { value: unknown; updated_by: string | null } | undefined;

const patch = (payload: unknown, headers: Record<string, string> = adminHeaders) => app.inject({ method: 'PATCH', url: '/v1/admin/ai-models', headers, payload: payload as object });
const state = async (headers: Record<string, string> = adminHeaders) => (await app.inject({ method: 'GET', url: '/v1/admin/ai-models', headers })).json();

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, diagnosis: {
    logs: null, ai: new OpenRouterClient({ apiKey: 'k', model: DEFAULT, fetchImpl: async () => new Response('{}', { status: 500 }) }),
    models: new OpenRouterCatalog({ fetchImpl: fakeCatalog }),
  } });
  await app.ready();
  held = (await app.db.query(`select value, updated_by from luna_feedback.app_settings where key = 'ai_models'`)).rows[0];
  await app.db.query(`delete from luna_feedback.app_settings where key = 'ai_models'`);
});
afterAll(async () => {
  if (held) await app.db.query(`update luna_feedback.app_settings set value = $1, updated_by = $2 where key = 'ai_models'`, [held.value, held.updated_by]);
  else await app.db.query(`delete from luna_feedback.app_settings where key = 'ai_models'`);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%+${run}@${DOMAIN}`]);
  await app.close();
});

describe('the model list', () => {
  it('reads OpenRouter\'s entry into prices per million tokens and what the model can do', () => {
    expect(toModelInfo(model('a/b', { images: false, prompt: '0.00000025', completion: '0.0000015', expires: '2026-12-01' }))).toEqual({
      id: 'a/b', name: 'Test: a/b', context_length: 128_000, input_per_m: 0.25, output_per_m: 1.5, images: false, structured: true, expires: '2026-12-01',
    });
    // Routers price per request ("-1"): no per-token price rather than a negative one.
    expect(toModelInfo(model('openrouter/auto', { prompt: '-1', completion: '-1' }))).toMatchObject({ input_per_m: null, output_per_m: null });
    expect(toModelInfo(model('x/painter', { out: ['image'] }))).toBeNull();
    expect(toModelInfo({ name: 'no id' })).toBeNull();
  });

  it('lists the models that answer in text, and is fetched once, not per request', async () => {
    const before = catalogCalls;
    const r = await app.inject({ method: 'GET', url: '/v1/admin/ai-models/available', headers: adminHeaders });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((m: { id: string }) => m.id)).toEqual([DEFAULT, 'test/vision-json', 'test/text-json', 'test/prose']);
    await app.inject({ method: 'GET', url: '/v1/admin/ai-models/available', headers: adminHeaders });
    expect(catalogCalls - before).toBeLessThanOrEqual(1);
  });

  it('keeps answering from the list it holds when OpenRouter is down; with none held it says so', async () => {
    catalogUp = false;
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/admin/ai-models/available', headers: adminHeaders })).statusCode).toBe(200);
      const empty = new OpenRouterCatalog({ fetchImpl: fakeCatalog });
      await expect(empty.list()).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_ERROR' });
    } finally { catalogUp = true; }
  });
});

describe('choosing models', () => {
  it('starts on the environment\'s defaults, the chat following the diagnosis model', async () => {
    expect(await state()).toMatchObject({
      enabled: true,
      diagnosis: { id: DEFAULT, images: true, set: false },
      chat: { id: DEFAULT, set: false },
      defaults: { diagnosis: DEFAULT, chat: null },
      updated_by: null,
    });
  });

  it('refuses a model OpenRouter does not offer, and a diagnosis model that cannot answer in JSON', async () => {
    const unknown = await patch({ diagnosis: 'nobody/nothing' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.issues).toEqual([{ path: 'diagnosis', message: 'nobody/nothing is not a model OpenRouter offers' }]);
    const prose = await patch({ diagnosis: 'test/prose' });
    expect(prose.statusCode).toBe(422);
    expect(prose.json().error.issues[0].message).toContain('structured outputs');
    expect((await patch({})).statusCode).toBe(422);
    expect((await patch({ diagnosis: 'test/vision-json', extra: 1 })).statusCode).toBe(422);
    // Nothing was stored by any of those.
    expect((await state()).diagnosis.set).toBe(false);
  });

  it('a prose-only model may still chat', async () => {
    const r = await patch({ chat: 'test/prose' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ diagnosis: { id: DEFAULT, set: false }, chat: { id: 'test/prose', set: true }, updated_by: 'admin_key' });
  });

  it('changes the diagnosis model, leaves the chat as it was, and analytics names both', async () => {
    const r = await patch({ diagnosis: 'test/text-json' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ diagnosis: { id: 'test/text-json', images: false, set: true }, chat: { id: 'test/prose', set: true } });
    const usage = (await app.inject({ method: 'GET', url: '/v1/analytics/model-usage', headers: appHeaders })).json();
    expect(usage).toMatchObject({ current_model: 'test/text-json', chat_model: 'test/prose', enabled: true });
  });

  it('null goes back to the default; the chat then follows the diagnosis model again', async () => {
    expect((await patch({ chat: null })).json().chat).toEqual({ id: 'test/text-json', set: false });
    const back = (await patch({ diagnosis: null })).json();
    expect(back.diagnosis).toEqual({ id: DEFAULT, images: true, set: false });
    expect(back.chat).toEqual({ id: DEFAULT, set: false });
  });

  it('only admins may change them; everyone signed in may look', async () => {
    const email = `qc+${run}@${DOMAIN}`;
    const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email, role: 'qc' } })).json().generated_password;
    const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email, password: pass } });
    const qc = { ...dash, cookie: String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '' };
    expect((await app.inject({ method: 'GET', url: '/v1/admin/ai-models', headers: qc })).statusCode).toBe(200);
    expect((await patch({ diagnosis: 'test/vision-json' }, qc)).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/v1/admin/ai-models', headers: appHeaders, payload: { diagnosis: 'test/vision-json' } })).statusCode).toBe(401);
  });
});
