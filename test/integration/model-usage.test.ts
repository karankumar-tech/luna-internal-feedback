import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';
import { ModelUsageRepo, USAGE_WINDOW_DAYS } from '../../src/modules/analytics/model-usage.repo.js';
import { todayInZone } from '../../src/lib/time.js';

/** Daily token counts: written per model call, read back over the last 30 days, older rows dropped. */
const MODEL = `test/usage-${Date.now()}`;
const OTHER = `${MODEL}-chat`;
const cfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', CATEGORY_CACHE_TTL_MS: '0', OPENROUTER_MODEL: MODEL, DIAGNOSIS_CHAT_MODEL: OTHER });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY };

let app: App;
let repo: ModelUsageRepo;
let aiCalls = 0;
const fakeAi: typeof fetch = async () => {
  aiCalls += 1;
  return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: '{"verdicts":[]}' } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const ai = new OpenRouterClient({ apiKey: 'k', model: MODEL, fetchImpl: fakeAi });

const cleanup = () => app.db.query(`delete from luna_feedback.model_usage_daily where model like $1`, [`test/usage-%`]);

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, diagnosis: { logs: null, ai } });
  await app.ready();
  repo = new ModelUsageRepo(app.db, cfg.APP_TIMEZONE);
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('model usage', () => {
  it('adds every call to the day and model it belongs to', async () => {
    const today = todayInZone(cfg.APP_TIMEZONE);
    await repo.record({ model: MODEL, promptTokens: 300, completionTokens: 20 });
    await repo.record({ model: MODEL, promptTokens: 200, completionTokens: 30 });
    await repo.record({ model: OTHER, promptTokens: 50, completionTokens: 5 });
    const yesterday = new Date(Date.now() - 86_400_000);
    await repo.record({ model: MODEL, promptTokens: 10, completionTokens: 1, at: yesterday });

    const r = await app.inject({ method: 'GET', url: '/v1/analytics/model-usage', headers: appHeaders });
    expect(r.statusCode).toBe(200);
    const u = r.json();
    expect(u.current_model).toBe(MODEL);
    expect(u.chat_model).toBe(OTHER);
    expect(u.enabled).toBe(true);
    expect(u.by_day).toHaveLength(USAGE_WINDOW_DAYS);
    expect(u.by_day[USAGE_WINDOW_DAYS - 1].date).toBe(today);
    expect(u.range).toEqual({ from: u.by_day[0].date, to: today });
    const mine = u.by_model.filter((m: { model: string }) => m.model.startsWith('test/usage-'));
    expect(mine).toEqual([
      { model: MODEL, input_tokens: 510, output_tokens: 51, calls: 3, first_used: todayInZone(cfg.APP_TIMEZONE, yesterday), last_used: today },
      { model: OTHER, input_tokens: 50, output_tokens: 5, calls: 1, first_used: today, last_used: today },
    ]);
    // Other test runs may have left today's row for real models; only check that ours are included.
    const todayRow = u.by_day[USAGE_WINDOW_DAYS - 1];
    expect(todayRow.input_tokens).toBeGreaterThanOrEqual(550);
    expect(todayRow.output_tokens).toBeGreaterThanOrEqual(55);
    expect(todayRow.calls).toBeGreaterThanOrEqual(3);
    expect(u.totals.input_tokens).toBeGreaterThanOrEqual(560);
  });

  it('drops rows older than the window as new ones land', async () => {
    const old = new Date(Date.now() - (USAGE_WINDOW_DAYS + 5) * 86_400_000);
    await repo.record({ model: MODEL, promptTokens: 1, completionTokens: 1, at: old });
    const before = await app.db.query(`select count(*)::int as n from luna_feedback.model_usage_daily where model = $1 and day < current_date - 30`, [MODEL]);
    expect(before.rows[0].n).toBe(1);
    await repo.record({ model: MODEL, promptTokens: 1, completionTokens: 1 });
    const after = await app.db.query(`select count(*)::int as n from luna_feedback.model_usage_daily where model = $1 and day < current_date - 30`, [MODEL]);
    expect(after.rows[0].n).toBe(0);
  });

  it('counts a call made through the app\'s model client', async () => {
    const todayBefore = (await app.inject({ method: 'GET', url: '/v1/analytics/model-usage', headers: appHeaders })).json();
    const row = (u: { by_model: { model: string; calls: number; input_tokens: number }[] }) => u.by_model.find((m) => m.model === MODEL)!;
    await ai.completeJson([{ role: 'user', content: 'x' }], {});
    expect(aiCalls).toBe(1);
    // The sink writes in the background; give it a moment.
    let u = todayBefore;
    for (let i = 0; i < 40 && row(u).calls === row(todayBefore).calls; i++) { await sleep(100); u = (await app.inject({ method: 'GET', url: '/v1/analytics/model-usage', headers: appHeaders })).json(); }
    expect(row(u).calls).toBe(row(todayBefore).calls + 1);
    expect(row(u).input_tokens).toBe(row(todayBefore).input_tokens + 1000);
  });
});
