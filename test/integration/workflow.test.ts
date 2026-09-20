import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { JiraClient } from '../../src/modules/jira/jira.client.js';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';

/**
 * Environment tagging, triage status, issue kinds, the Jira link and the per-ticket chat.
 * One app, one email domain, cleaned up at both ends so a failed run cannot leave rows behind.
 */
const DOMAIN = 'luna-workflow-test.invalid';
const run = `${Date.now()}`;
const USER = 900042;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent' });
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };

// --- fake Jira -----------------------------------------------------------------
const jiraCalls: { method: string; url: string; body: unknown }[] = [];
const fakeJiraFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  jiraCalls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.includes('/rest/api/3/issue') && init?.method === 'POST') {
    return new Response(JSON.stringify({ key: 'LUNA-77', id: '10077' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/rest/api/3/issue/')) {
    return new Response(JSON.stringify({ key: 'LUNA-77', fields: { status: { name: 'In Progress' }, summary: 'x', assignee: null, updated: '2026-09-20T10:00:00.000+0530' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/rest/api/3/project/')) {
    return new Response(JSON.stringify({ key: 'LUNA', name: 'Luna' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

const body = (over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-09-01', user_id: USER,
  email: `wf+${run}@${DOMAIN}`, issue_categories: ['wrong_peak_score'], feedback_text: 'Peak score looked wrong',
  ...over,
});

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.issue_kinds where key like $1`, [`wf_${run}%`]);
}

beforeAll(async () => {
  app = buildApp({
    config: cfg, logger: false,
    diagnosis: { logs: null, ai: null },
    jira: new JiraClient(
      { baseUrl: 'https://example.atlassian.net', email: 'bot@example.com', apiToken: 'token-token', projectKey: 'LUNA', issueType: 'Bug', labels: ['luna-feedback'] },
      fakeJiraFetch,
    ),
  });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('environment tagging', () => {
  it('defaults to stage and accepts uat / production case-insensitively', async () => {
    const plain = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json();
    expect(plain.environment).toBe('stage');

    const uat = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body({ client: { environment: 'UAT', platform: 'iOS' } }) })).json();
    expect(uat.environment).toBe('uat');
    expect(uat.platform).toBe('ios');

    const prod = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body({ client: { environment: 'production' } }) })).json();
    expect(prod.environment).toBe('production');
  });

  it('rejects an environment outside the list', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body({ client: { environment: 'dev' } }) });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('client.environment');
  });

  it('filters lists and stats by environment', async () => {
    const list = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=${USER}&environment=production`, headers: appHeaders })).json();
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    expect(list.items.every((i: { environment: string }) => i.environment === 'production')).toBe(true);

    const stats = (await app.inject({ method: 'GET', url: `/v1/feedback/stats?user_id=${USER}&from=2026-09-01&to=2026-09-01`, headers: appHeaders })).json();
    const envs = Object.fromEntries(stats.by_environment.map((e: { environment: string; negative: number }) => [e.environment, e.negative]));
    expect(envs.stage).toBeGreaterThanOrEqual(1);
    expect(envs.uat).toBeGreaterThanOrEqual(1);
    expect(envs.production).toBeGreaterThanOrEqual(1);
  });

  it('advertises the field in the schema so the app knows the allowed values', async () => {
    const schema = (await app.inject({ method: 'GET', url: '/v1/feedback/schema', headers: appHeaders })).json();
    expect(schema.client_context_keys).toContain('environment');
    const field = schema.client_context_fields.find((f: { key: string }) => f.key === 'environment');
    expect(field.options).toEqual(['stage', 'uat', 'production']);
  });
});

describe('triage status', () => {
  it('starts open, records who changed it, and filters by it', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    expect((await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: appHeaders })).json().status).toBe('open');

    const moved = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}`, headers: adminHeaders, payload: { status: 'in_progress', status_note: 'reproduced on 1.2.6' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe('in_progress');
    expect(moved.json().status_note).toBe('reproduced on 1.2.6');
    expect(moved.json().status_changed_by).toBe('admin_key');
    expect(moved.json().status_changed_at).not.toBeNull();

    const open = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=${USER}&status=in_progress`, headers: appHeaders })).json();
    expect(open.items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('rejects an unknown status and an empty patch', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}`, headers: adminHeaders, payload: { status: 'nope' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}`, headers: adminHeaders, payload: {} })).statusCode).toBe(422);
  });

  it('still accepts an is_test-only patch', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    const r = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${id}`, headers: adminHeaders, payload: { is_test: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().is_test).toBe(false);
    expect(r.json().status).toBe('open');
  });
});

describe('issue kinds', () => {
  let kindId = '';
  let submissionId = '';

  it('creates a kind, slugifying the title', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { title: `WF ${run} sleep start recorded late`, description: 'Recorded start is hours after the real one.' } });
    expect(r.statusCode).toBe(201);
    kindId = r.json().id;
    expect(r.json().key).toMatch(/^wf_\d+_sleep_start_recorded_late$/);
    expect(r.json().status).toBe('open');
  });

  it('refuses an unknown catalog event code', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { title: `WF ${run} bogus`, event_codes: ['FW-01', 'NOPE-1'] } });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('NOPE-1');
  });

  it('links a ticket and counts it', async () => {
    submissionId = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    const linked = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${submissionId}/kinds`, headers: adminHeaders, payload: { kind_id: kindId } });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().items.map((k: { kind_id: string }) => k.kind_id)).toContain(kindId);
    expect(linked.json().items[0].source).toBe('manual');

    const list = (await app.inject({ method: 'GET', url: '/v1/kinds?from=2026-09-01&to=2026-09-01&is_test=true', headers: appHeaders })).json();
    const mine = list.items.find((k: { id: string }) => k.id === kindId);
    expect(mine.count).toBe(1);
    expect(mine.users).toBe(1);
    expect(mine.open_count).toBe(1);
    expect(mine.first_seen).toBe('2026-09-01');
  });

  it('creates and links in one step from a ticket', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    const r = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/kinds`, headers: adminHeaders, payload: { title: `WF ${run} brand new kind` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(1);
  });

  it('rejects sending both kind_id and title', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${submissionId}/kinds`, headers: adminHeaders, payload: { kind_id: kindId, title: 'both' } });
    expect(r.statusCode).toBe(422);
  });

  it('serves a detail view with a per-day trend', async () => {
    const d = (await app.inject({ method: 'GET', url: `/v1/kinds/${kindId}?from=2026-09-01&to=2026-09-01&is_test=true`, headers: appHeaders })).json();
    expect(d.count).toBe(1);
    expect(d.trend).toEqual([{ date: '2026-09-01', count: 1 }]);
  });

  it('filters the submission list by kind', async () => {
    const list = (await app.inject({ method: 'GET', url: `/v1/feedback?kind_id=${kindId}`, headers: appHeaders })).json();
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([submissionId]);
  });

  it('unlinks and 404s a second unlink', async () => {
    const r = await app.inject({ method: 'DELETE', url: `/v1/admin/submissions/${submissionId}/kinds/${kindId}`, headers: adminHeaders });
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/v1/admin/submissions/${submissionId}/kinds/${kindId}`, headers: adminHeaders })).statusCode).toBe(404);
  });

  it('updates status and refuses a duplicate key', async () => {
    const patched = await app.inject({ method: 'PATCH', url: `/v1/admin/kinds/${kindId}`, headers: adminHeaders, payload: { status: 'fixed', severity: 'high' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe('fixed');

    const dupe = await app.inject({ method: 'POST', url: '/v1/admin/kinds', headers: adminHeaders, payload: { title: 'Anything', key: patched.json().key } });
    expect(dupe.statusCode).toBe(422);
  });
});

describe('jira', () => {
  it('reports itself configured and verifies the project', async () => {
    const status = (await app.inject({ method: 'GET', url: '/v1/admin/jira/status', headers: adminHeaders })).json();
    expect(status.configured).toBe(true);
    expect(status.project_key).toBe('LUNA');
    expect(status.missing_env).toEqual([]);
    expect(status.message).toBeNull();

    const check = (await app.inject({ method: 'POST', url: '/v1/admin/jira/check', headers: adminHeaders })).json();
    expect(check).toMatchObject({ ok: true, project: 'LUNA' });
  });

  it('creates one ticket per submission and is idempotent on a second click', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body({ client: { environment: 'uat' } }) })).json().id;
    jiraCalls.length = 0;

    const first = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/jira`, headers: adminHeaders });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ key: 'LUNA-77', created: true, status: 'In Progress' });

    const created = jiraCalls.find((c) => c.method === 'POST')!;
    const fields = (created.body as { fields: { project: { key: string }; summary: string; labels: string[] } }).fields;
    expect(fields.project.key).toBe('LUNA');
    expect(fields.summary).toContain('[uat]');
    expect(fields.labels).toContain('luna-feedback');
    expect(fields.labels).toContain('env-uat');

    const stored = (await app.inject({ method: 'GET', url: `/v1/feedback/${id}`, headers: appHeaders })).json();
    expect(stored.jira_key).toBe('LUNA-77');
    expect(stored.jira_url).toBe('https://example.atlassian.net/browse/LUNA-77');
    expect(stored.jira_status).toBe('In Progress');
    expect(stored.jira_created_by).toBe('admin_key');

    jiraCalls.length = 0;
    const second = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/jira`, headers: adminHeaders });
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(jiraCalls.some((c) => c.method === 'POST')).toBe(false);

    const withJira = (await app.inject({ method: 'GET', url: `/v1/feedback?user_id=${USER}&jira=any`, headers: appHeaders })).json();
    expect(withJira.items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('refuses to refresh a submission that has no ticket', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/jira/refresh`, headers: adminHeaders })).statusCode).toBe(422);
  });

  it('answers "Jira integration pending" when the credentials are absent', async () => {
    const off = buildApp({ config: cfg, logger: false, diagnosis: { logs: null, ai: null }, jira: null });
    await off.ready();
    try {
      const status = (await off.inject({ method: 'GET', url: '/v1/admin/jira/status', headers: adminHeaders })).json();
      expect(status.configured).toBe(false);
      expect(status.message).toBe('Jira integration pending');
      expect(status.missing_env).toEqual(['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']);

      const id = (await off.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
      const attempt = await off.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/jira`, headers: adminHeaders });
      expect(attempt.statusCode).toBe(422);
      expect(attempt.json().error.message).toBe('Jira integration pending');
    } finally { await off.close(); }
  });
});

describe('analytics', () => {
  it('summarises the same slice the list shows', async () => {
    const o = (await app.inject({ method: 'GET', url: `/v1/analytics/overview?user_id=${USER}&from=2026-09-01&to=2026-09-01&is_test=true`, headers: appHeaders })).json();
    expect(o.totals.issues).toBeGreaterThanOrEqual(5);
    expect(o.totals.users).toBe(1);
    expect(o.by_environment.map((e: { environment: string }) => e.environment).sort()).toEqual(['production', 'stage', 'uat']);
    expect(o.by_status.find((s: { status: string }) => s.status === 'open').count).toBeGreaterThanOrEqual(1);
    expect(o.jira.linked).toBeGreaterThanOrEqual(1);
    expect(o.top_reporters[0]).toMatchObject({ user_id: USER });
  });

  it('serves the event catalog for filters and reference', async () => {
    const all = (await app.inject({ method: 'GET', url: '/v1/catalog/events', headers: appHeaders })).json();
    expect(all.count).toBeGreaterThan(100);
    expect(all.items[0]).toHaveProperty('id');
    // The match probes are an internal detail and must not be served.
    expect(all.items[0]).not.toHaveProperty('match');

    const sdk = (await app.inject({ method: 'GET', url: '/v1/catalog/events?domain=sdk&q=disconnect', headers: appHeaders })).json();
    expect(sdk.count).toBeGreaterThan(0);
    expect(sdk.items.every((e: { domain: string }) => e.domain === 'sdk')).toBe(true);
  });
});

describe('per-ticket diagnosis chat', () => {
  it('is disabled with a clear message when no model key is configured', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
    const state = (await app.inject({ method: 'GET', url: `/v1/feedback/${id}/diagnosis/chat`, headers: appHeaders })).json();
    expect(state).toMatchObject({ enabled: false, used: 0, remaining: cfg.DIAGNOSIS_CHAT_MAX_MESSAGES });

    const send = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/diagnosis/chat`, headers: adminHeaders, payload: { message: 'why?' } });
    expect(send.statusCode).toBe(422);
    expect(send.json().error.message).toContain('Chat unavailable');
  });

  it('answers, stores both turns, and stops at the per-ticket cap', async () => {
    let replies = 0;
    const fakeAiFetch: typeof fetch = async () => {
      replies += 1;
      return new Response(JSON.stringify({
        model: 'test/model', choices: [{ message: { content: `answer ${replies}` } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const chatApp = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', DIAGNOSIS_CHAT_MAX_MESSAGES: '2' }),
      logger: false,
      diagnosis: { logs: null, ai: new OpenRouterClient({ apiKey: 'k', model: 'test/model', fetchImpl: fakeAiFetch }) },
      jira: null,
    });
    await chatApp.ready();
    try {
      const id = (await chatApp.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;

      const first = await chatApp.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/diagnosis/chat`, headers: adminHeaders, payload: { message: 'Could this be the ring instead?' } });
      expect(first.statusCode).toBe(200);
      expect(first.json().messages).toHaveLength(2);
      expect(first.json().messages[0]).toMatchObject({ role: 'user', author: 'admin_key' });
      expect(first.json().messages[1]).toMatchObject({ role: 'assistant', content: 'answer 1' });
      expect(first.json().remaining).toBe(1);

      const second = await chatApp.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/diagnosis/chat`, headers: adminHeaders, payload: { message: 'And on Android?' } });
      expect(second.json().remaining).toBe(0);
      expect(second.json().messages).toHaveLength(4);

      const third = await chatApp.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/diagnosis/chat`, headers: adminHeaders, payload: { message: 'one more' } });
      expect(third.statusCode).toBe(429);
      expect(replies).toBe(2);

      // History survives a fresh read, and the cap is reported to the UI.
      const state = (await chatApp.inject({ method: 'GET', url: `/v1/feedback/${id}/diagnosis/chat`, headers: appHeaders })).json();
      expect(state.used).toBe(2);
      expect(state.messages.map((m: { content: string }) => m.content)).toContain('answer 2');
    } finally { await chatApp.close(); }
  });

  it('does not spend a turn when the model call fails', async () => {
    const failing: typeof fetch = async () => new Response('{"error":{"message":"upstream is down"}}', { status: 500, headers: { 'content-type': 'application/json' } });
    const chatApp = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent' }),
      logger: false,
      diagnosis: { logs: null, ai: new OpenRouterClient({ apiKey: 'k', model: 'test/model', fetchImpl: failing }) },
      jira: null,
    });
    await chatApp.ready();
    try {
      const id = (await chatApp.inject({ method: 'POST', url: '/v1/feedback/home', headers: appHeaders, payload: body() })).json().id;
      const r = await chatApp.inject({ method: 'POST', url: `/v1/admin/submissions/${id}/diagnosis/chat`, headers: adminHeaders, payload: { message: 'hello?' } });
      expect(r.statusCode).toBe(502);
      const state = (await chatApp.inject({ method: 'GET', url: `/v1/feedback/${id}/diagnosis/chat`, headers: appHeaders })).json();
      expect(state.used).toBe(0);
      expect(state.messages).toHaveLength(0);
    } finally { await chatApp.close(); }
  });
});
