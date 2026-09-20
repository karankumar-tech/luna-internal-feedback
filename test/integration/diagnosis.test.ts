import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { LogsClient } from '../../src/modules/diagnosis/logs/client.js';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';

/**
 * End-to-end diagnosis with the logging API and OpenRouter replaced by in-memory fakes.
 * Uses the real database (rows are flagged is_test and cleaned up).
 */
const DOMAIN = 'luna-test.invalid';
const run = `${Date.now()}`;
const S3 = 'https://stage-s3.example.invalid/logreport';

// --- fake logging API -------------------------------------------------------
const listCalls: string[] = [];
const fakeLogsFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  listCalls.push(url.search);
  const email = url.searchParams.get('email');
  const serial = url.searchParams.get('serial_no');
  if (serial === 'R2NTEST0001' || email === `diag+${run}@${DOMAIN}`) {
    return new Response(JSON.stringify({ success: true, data: [{
      user_id: 900010, device_id: 1, platform: 'android', device_model: 'CPH2447', device_manufacturer: 'OnePlus', os_version: '13',
      fv: '1.2.6', version_name: '2.0.3.staging.luna', batt_perct: 90, updated_at: '2026-09-01T16:00:00.000Z',
      app_logs: `${S3}/app_logs/900010-2026-09-01/1_appLogs.txt,${S3}/app_logs/900010-2026-08-31/2_appLogs.txt`,
      ring_logs: `${S3}/ring_logs/900010-2026-09-01/3_watchLogs.txt`,
      firmware_logs: `${S3}/firmware_logs/900010-2026-09-01/4_firmware_logs.txt`,
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (email === `nologs+${run}@${DOMAIN}`) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  if (email === `stale+${run}@${DOMAIN}`) {
    return new Response(JSON.stringify({ success: true, data: [{ user_id: 1, platform: 'ios', updated_at: '2026-08-30T10:00:00.000Z',
      app_logs: `${S3}/app_logs/1-2026-08-31/9_appLogs.txt`, ring_logs: '', firmware_logs: '' }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
};

// --- fake S3 ------------------------------------------------------------------
const APP_LOG = [
  '==============================================================================',
  '{ "success": true, "data": { "sleep": { "duration": 240 } }, "message": "", "time": "1788225000000" }',
  '==============================================================================',
  '{ "success": false, "data": null, "message": "sleep sync timeout", "error": { "code": 504 }, "time": "1788225300000" }',
  '==============================================================================',
].join('\n');
const RING_LOG = '── ring-trace log opened at 2026-09-01 06:40:00.000 ──\n<TL> [V2.4.5][SDK][ConnectState] ZHDConnectStateDisconnected\n<TL> [V2.4.5][SDK][Sync] dailysync failed timeout\n';
const FW_LOG = '9-1 06:41:10:100 cmd: 113,17\n9-1 06:41:12:200 Sar_status: 1,init_st: 0\n';
const fileFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('appLogs')) return new Response(APP_LOG, { status: 200 });
  if (url.includes('watchLogs')) return new Response(RING_LOG, { status: 200 });
  if (url.includes('firmware_logs')) return new Response(FW_LOG, { status: 200 });
  return new Response('not found', { status: 404 });
};

// --- fake OpenRouter -----------------------------------------------------------
let modelCalls = 0;
let lastPrompt = '';
let lastImageUrls: string[] = [];
const fakeAiFetch: typeof fetch = async (_input, init) => {
  modelCalls += 1;
  const body = JSON.parse(String(init?.body));
  const content = body.messages[1].content;
  lastPrompt = typeof content === 'string' ? content : content.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('\n');
  lastImageUrls = typeof content === 'string' ? [] : content.filter((p: { type: string }) => p.type === 'image_url').map((p: { image_url: { url: string } }) => p.image_url.url);
  const verdict = {
    root_cause_side: 'backend', confidence: 0.8, severity: 'high', tags: ['sync_timeout', 'api_error_5xx'], reproducible: 'likely',
    summary: 'The sleep sync request timed out (504) while the ring had disconnected shortly before; data never reached the app.',
    evidence: [{ source: 'app', ts: '06:45:00', line: 'FAIL success=false message="sleep sync timeout"', why: 'server timeout' }],
    suggested_fix: 'Check the sleep sync endpoint latency on the backend; add retry in the app.',
    questions_for_tester: ['Was the ring connected when you opened the app?'],
    fw_version_seen: '1.2.6', app_version_seen: '2.0.3.staging.luna',
    // One real catalog id and one the model invented: only the real one may survive.
    event_codes: ['APP-01', 'FW-9999'],
    issue_kind: { title: 'Sleep sync times out and the night is lost', rationale: 'Sync request returned 504 and no sleep data landed.' },
  };
  return new Response(JSON.stringify({ model: 'google/gemini-3.1-flash-lite', choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 3200, completion_tokens: 420, cost: 0.0014 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', DIAGNOSIS_AUTO: 'true', IMAGEKIT_PUB_KEY: 'public_test_key', IMAGEKIT_PRI_KEY: 'private_test_key', IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/testacct' });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
// "now" is 2026-09-01 22:00 IST: after the sync hour, so same-day logs are expected to exist.
const NOW = new Date('2026-09-01T16:30:00.000Z');

const body = (email: string, over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-09-01', user_id: 900010, email,
  issue_categories: ['incorrect_sleep'], feedback_text: 'Sleep showed 4h, I slept 7h.',
  details: { actual_start_time: '11:30 PM', actual_end_time: '06:45 AM' }, client: { platform: 'android' }, ...over,
});

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({
    config: cfg, logger: false,
    diagnosis: {
      logs: new LogsClient({ baseUrl: 'https://stage-app.example.invalid', apiKey: 'k', fetchImpl: fakeLogsFetch }),
      ai: new OpenRouterClient({ apiKey: 'k', model: 'google/gemini-3.1-flash-lite', fetchImpl: fakeAiFetch }),
      fetchImpl: fileFetch,
      now: () => NOW,
    },
  });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Generous: a run is ~15 sequential queries and the hosted DB has been seen at ~600 ms/query.
async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 45_000, debug?: () => Promise<unknown>): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(150); }
  const state = debug ? JSON.stringify(await debug()).slice(0, 600) : '';
  throw new Error('timed out waiting' + (state ? ' — last state: ' + state : ''));
}

describe('auto diagnosis on negative submission', () => {
  it('queues, runs in the background, and stores a structured verdict', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: body(`diag+${run}@${DOMAIN}`, { device_serial: 'R2NTEST0001' }) });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const d = await waitFor(async () => { const x = await app.diagnosis.get(id); return x && x.status === 'done' ? x : null; }, 45_000, async () => { const x = await app.diagnosis.get(id); return x && { status: x.status, error: x.error, trigger: x.trigger }; });
    expect(d.root_cause_side).toBe('backend');
    expect(d.confidence).toBe(0.8);
    expect(d.severity).toBe('high');
    expect(d.tags).toEqual(['sync_timeout', 'api_error_5xx']);
    expect(d.log_coverage).toBe('full');
    expect(d.log_excerpt_lines).toBeGreaterThan(3);
    expect(d.log_excerpt_lines).toBeLessThanOrEqual(100);
    expect(d.log_excerpt).toContain('===== [app] app 2.0.3.staging.luna =====');
    expect(d.log_excerpt).toContain('sleep sync timeout');
    expect(d.log_files.app).toHaveLength(1);
    expect(d.log_device).toMatchObject({ platform: 'android', fv: '1.2.6' });
    expect(d.fw_version_seen).toBe('1.2.6');
    expect(d.cost_usd).toBeCloseTo(0.0014, 5);
    expect(d.trigger).toBe('auto');
    expect(listCalls.some((q) => q.includes('serial_no=R2NTEST0001'))).toBe(true);
    expect(lastPrompt).toContain('Sleep showed 4h');
    expect(lastPrompt).toContain('Actual sleep start: 11:30 PM');

    // Only catalog ids the model could have cited are kept; the invented one is dropped.
    expect(d.event_codes).toEqual(['APP-01']);

    // The suggested issue kind is created and linked, so tickets group without anyone filing them.
    const kinds = (await app.inject({ method: 'GET', url: `/v1/feedback/${id}/kinds`, headers: appHeaders })).json();
    expect(kinds.items).toHaveLength(1);
    expect(kinds.items[0].title).toBe('Sleep sync times out and the night is lost');
    expect(kinds.items[0].source).toBe('ai');

    // denormalised columns + list filter
    const list = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900010&ai_side=backend`, headers: appHeaders })).json();
    expect(list.items.map((i: { id: string }) => i.id)).toContain(id);
    expect(list.items[0].ai_status).toBe('done');
    const read = await app.inject({ method: 'GET', url: `/v1/feedback/${id}/diagnosis`, headers: appHeaders });
    expect(read.statusCode).toBe(200);
    expect(read.json().summary).toMatch(/timed out/);
    const runs = (await app.inject({ method: 'GET', url: `/v1/admin/submissions/${id}/diagnosis/runs`, headers: adminHeaders })).json();
    expect(runs.items).toHaveLength(1);
  });

  it('does not diagnose positive submissions', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body(`pos+${run}@${DOMAIN}`, { is_positive: true, issue_categories: ['wrong_peak_score'], details: {} }) });
    expect(r.statusCode).toBe(201);
    await sleep(300);
    expect(await app.diagnosis.get(r.json().id)).toBeNull();
  });

  it('parks a same-day report whose logs have not synced yet, and finalises no_logs for old ones', async () => {
    const before = modelCalls;
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: body(`stale+${run}@${DOMAIN}`, { client: { platform: 'ios' } }) });
    const id = r.json().id;
    const d = await waitFor(async () => { const x = await app.diagnosis.get(id); return x && x.status !== 'pending' && x.status !== 'running' ? x : null; });
    expect(d.status).toBe('waiting_logs');
    expect(d.error).toMatch(/before the issue day/);
    expect(modelCalls).toBe(before);
    const job = await app.db.query(`select state, run_after from luna_feedback.diagnosis_jobs where submission_id = $1`, [id]);
    expect(job.rows[0].state).toBe('queued');
    expect(new Date(job.rows[0].run_after).getTime()).toBeGreaterThan(NOW.getTime());

    const old = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body(`nologs+${run}@${DOMAIN}`, { occurred_on: '2026-08-20', issue_categories: ['wrong_peak_score'], details: {} }) });
    const d2 = await waitFor(async () => { const x = await app.diagnosis.get(old.json().id); return x && ['no_logs', 'done', 'failed'].includes(x.status) ? x : null; });
    expect(d2.status).toBe('no_logs');
    expect((await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900010&ai_status=no_logs`, headers: appHeaders })).json().items.length).toBeGreaterThanOrEqual(1);
  });

  it('manual re-run, review, summary and sweep endpoints', async () => {
    const list = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=900010&ai_side=backend`, headers: appHeaders })).json();
    const id = list.items[0].id;
    const rerun = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/diagnose`, headers: adminHeaders });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json().status).toBe('done');
    expect(rerun.json().diagnosis.trigger).toBe('manual');
    const runs = (await app.inject({ method: 'GET', url: `/v1/admin/submissions/${id}/diagnosis/runs`, headers: adminHeaders })).json();
    expect(runs.items).toHaveLength(2);

    const review = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}/diagnosis/review`, headers: adminHeaders, payload: { verdict: 'agree', note: 'matches what we saw', reviewer: 'karan' } });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ review_verdict: 'agree', reviewed_by: 'karan' });
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}/diagnosis/review`, headers: adminHeaders, payload: { verdict: 'maybe' } })).statusCode).toBe(422);

    const summary = (await app.inject({ method: 'GET', url: '/v1/admin/diagnoses/summary', headers: adminHeaders })).json();
    expect(summary.enabled).toBe(true);
    expect(summary.done).toBeGreaterThanOrEqual(1);
    expect(summary.spend_today).toBeGreaterThan(0);

    const sweep = await app.inject({ method: 'POST', url: '/v1/admin/diagnoses/run-pending', headers: adminHeaders });
    expect(sweep.statusCode).toBe(200);
    expect(Array.isArray(sweep.json().results)).toBe(true);

    const stats = (await app.inject({ method: 'GET', url: '/v1/feedback/stats?user_id=900010&from=2026-08-01&to=2026-09-02', headers: appHeaders })).json();
    expect(stats.diagnosis.with_verdict).toBeGreaterThanOrEqual(1);
    expect(stats.diagnosis.by_side.find((b: { side: string }) => b.side === 'backend').count).toBeGreaterThanOrEqual(1);
    expect(stats.diagnosis.top_tags.map((t: { tag: string }) => t.tag)).toContain('sync_timeout');

    const lookup = (await app.inject({ method: 'GET', url: `/v1/admin/logs/lookup?serial_no=R2NTEST0001`, headers: adminHeaders })).json();
    expect(lookup.items[0].files.app).toHaveLength(2);
  });

  it('the backfill queues negative submissions that were never diagnosed (automatic mode)', async () => {
    // Insert directly, bypassing the hook, as if it arrived before diagnosis existed.
    const ins = await app.db.query(
      `insert into luna_feedback.submissions (feature_key, is_positive, occurred_on, user_id, email, issue_categories, is_test, platform)
       values ('home', false, '2026-08-20', 900010, $1, '{wrong_peak_score}', true, 'android') returning id`, [`backfill+${run}@${DOMAIN}`]);
    const id = ins.rows[0].id;
    expect(await app.diagnosis.get(id)).toBeNull();
    // Exercise the backfill query itself rather than a full sweep, which would also process unrelated
    // jobs that share this database.
    const { DiagnosisRepo } = await import('../../src/modules/diagnosis/diagnosis.repo.js');
    const repo = new DiagnosisRepo(app.db);
    const queued = await repo.enqueueMissing(50);
    expect(queued).toBeGreaterThanOrEqual(1);
    const job = await app.db.query(`select state from luna_feedback.diagnosis_jobs where submission_id = $1`, [id]);
    expect(job.rows[0].state).toBe('queued');
    expect((await app.diagnosis.get(id))!.status).toBe('pending');
    const out = await app.diagnosis.run(id, 'auto');
    expect(['no_logs', 'waiting_logs', 'done']).toContain(out.status);
  });

  it('overview aggregates cover the diagnosed rows', async () => {
    const o = (await app.inject({ method: 'GET', url: '/v1/admin/diagnoses/overview?from=2026-08-01&to=2026-09-02&include_test=true', headers: adminHeaders })).json();
    expect(o.totals.diagnosed).toBeGreaterThanOrEqual(1);
    expect(o.side_by_feature.find((r: { side: string }) => r.side === 'backend')).toBeTruthy();
    expect(o.firmware_versions.find((r: { version: string }) => r.version === '1.2.6')).toBeTruthy();
    expect(o.tags.map((t: { tag: string }) => t.tag)).toContain('sync_timeout');
    expect(o.review_by_side.find((r: { side: string }) => r.side === 'backend').agree).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(o.cost_by_day)).toBe(true);
    const real = (await app.inject({ method: 'GET', url: '/v1/admin/diagnoses/overview?from=2026-08-01&to=2026-09-02', headers: adminHeaders })).json();
    expect(real.range.include_test).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/diagnoses/overview?from=2026-09-02&to=2026-09-01', headers: adminHeaders })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/dashboard/diagnosis' })).statusCode).toBe(200);
  });

  it('on-demand mode: nothing runs at submit time and the sweep does not backfill', async () => {
    const cfgOff = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DIAGNOSIS_AUTO: 'false', IMAGEKIT_PUB_KEY: 'public_test_key', IMAGEKIT_PRI_KEY: 'private_test_key', IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/testacct' });
    const appOff = buildApp({ config: cfgOff, logger: false, db: app.db, diagnosis: {
      logs: new LogsClient({ baseUrl: 'https://stage-app.example.invalid', apiKey: 'k', fetchImpl: fakeLogsFetch }),
      ai: new OpenRouterClient({ apiKey: 'k', model: 'google/gemini-3.1-flash-lite', fetchImpl: fakeAiFetch }),
      fetchImpl: fileFetch, now: () => NOW } });
    await appOff.ready();
    const before = modelCalls;
    const r = await appOff.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: body(`ondemand+${run}@${DOMAIN}`, { device_serial: 'R2NTEST0001' }) });
    expect(r.statusCode).toBe(201);
    await sleep(400);
    expect(await appOff.diagnosis.get(r.json().id)).toBeNull();
    const sweep = (await appOff.inject({ method: 'POST', url: '/v1/admin/diagnoses/run-pending', headers: adminHeaders })).json();
    expect(sweep.results.map((x: { submission_id: string }) => x.submission_id)).not.toContain(r.json().id);
    expect(modelCalls).toBe(before);
    expect((await appOff.inject({ method: 'GET', url: '/v1/admin/diagnoses/summary', headers: adminHeaders })).json().auto).toBe(false);
    // Diagnose now still works and downloads one file per source
    const manual = (await appOff.inject({ method: 'POST', url: `/v1/admin/submissions/${r.json().id}/diagnose`, headers: adminHeaders })).json();
    expect(manual.status).toBe('done');
    expect(lastImageUrls).toEqual([]);

    // with screenshots attached, the model receives them as sized image parts (max two)
    const shot = (n: number) => ({ file_id: 'f' + n, url: `https://ik.imagekit.io/testacct/luna-feedback-screenshots/s${n}.png` });
    const withShots = await appOff.inject({ method: 'POST', url: '/v1/feedback/sleep', headers: appHeaders, payload: body(`shots+${run}@${DOMAIN}`, { device_serial: 'R2NTEST0001', screenshots: [shot(1), shot(2), shot(3)] }) });
    const out = (await appOff.inject({ method: 'POST', url: `/v1/admin/submissions/${withShots.json().id}/diagnose`, headers: adminHeaders })).json();
    expect(out.status).toBe('done');
    expect(lastImageUrls).toEqual([
      'https://ik.imagekit.io/testacct/luna-feedback-screenshots/s1.png?tr=w-1024%2Cq-80',
      'https://ik.imagekit.io/testacct/luna-feedback-screenshots/s2.png?tr=w-1024%2Cq-80',
    ]);
    expect(lastPrompt).toContain('# Screenshots');
    expect(manual.diagnosis.log_files.app).toHaveLength(1);
    expect(manual.diagnosis.log_files.ring).toHaveLength(1);
    await appOff.close();
  });

  it('cron bearer can call the sweep when CRON_SECRET is set', async () => {
    const cfg2 = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', CRON_SECRET: 'cron-secret-for-tests-123' });
    const app2 = buildApp({ config: cfg2, logger: false, db: app.db, diagnosis: { logs: null, ai: null } });
    await app2.ready();
    expect((await app2.inject({ method: 'GET', url: '/v1/admin/diagnoses/run-pending', headers: { authorization: 'Bearer cron-secret-for-tests-123' } })).statusCode).toBe(200);
    expect((await app2.inject({ method: 'GET', url: '/v1/admin/diagnoses/run-pending', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app2.inject({ method: 'GET', url: '/v1/admin/features', headers: { authorization: 'Bearer cron-secret-for-tests-123' } })).statusCode).toBe(401);
    await app2.close();
  });
});
