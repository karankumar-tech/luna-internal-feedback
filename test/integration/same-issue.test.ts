import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';
import { KindsRepo } from '../../src/modules/kinds/kinds.repo.js';
import { KindsService } from '../../src/modules/kinds/kinds.service.js';

/**
 * Same-issue linking: similar reports, mark as same, suggestions at intake, confirm / reject,
 * merge, reference reports, the AI check and who may do what. Reports sit in March 2026 so the
 * matcher's 90-day window never reaches other test files' data; everything is removed afterwards.
 */
const DOMAIN = 'luna-same-test.invalid';
const run = `${Date.now()}`;
const TITLE = (s: string) => `ZZ same ${run} ${s}`;

// Fake model: "same" for the first candidate, "different" for the rest, plus a reference it was never sent.
let modelCalls = 0;
const fakeAi: typeof fetch = async (_input, init) => {
  modelCalls += 1;
  const prompt = String(JSON.parse(String(init?.body)).messages[1].content);
  const refs = [...prompt.matchAll(/^## (LN-\d+)/gm)].map((m) => m[1]!);
  const verdicts = [
    ...refs.map((ref, i) => ({ ref, verdict: i === 0 ? 'same' : 'different', reason: i === 0 ? 'Same late sleep start.' : 'Different symptom.' })),
    { ref: 'LN-99999999', verdict: 'same', reason: 'invented' },
  ];
  return new Response(JSON.stringify({ model: 'google/gemini-3.1-flash-lite', choices: [{ message: { content: JSON.stringify({ verdicts }) } }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.0004 } }), { status: 200 });
};

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', CX_API_KEY: `cx_same_key_${run}` });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const appHeaders = { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' };
const cxHeaders = { 'x-api-key': cfg.CX_API_KEY!, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

const LATE = 'Sleep start was recorded three hours late, I was asleep by 11 pm';
const people = new Map<string, number>();
const userOf = (who: string) => { if (!people.has(who)) people.set(who, 900100 + people.size); return people.get(who)!; };
const report = (who: string, over: Record<string, unknown> = {}) => ({
  is_test: true, is_positive: false, occurred_on: '2026-03-10', user_id: userOf(who), email: `${who}+${run}@${DOMAIN}`,
  issue_categories: ['incorrect_sleep'], feedback_text: LATE,
  client: { platform: 'ios', app_version: '2.4.0', firmware_version: '1.9.3' }, ...over,
});
const post = async (who: string, over: Record<string, unknown> = {}, feature = 'sleep') =>
  (await app.inject({ method: 'POST', url: `/v1/feedback/${feature}`, headers: appHeaders, payload: report(who, over) })).json() as { id: string; ref: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('timed out'); await sleep(100); }
}
const linksOf = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/feedback/${id}/kinds`, headers: appHeaders })).json().items as { kind_id: string; ref: string; title: string; state: string; source: string; counts: { count: number; users: number; cx_count: number } | null }[];

async function cleanup() {
  await app.db.query(`delete from luna_feedback.submissions where email like $1 or cx_ref like $2`, [`%@${DOMAIN}`, `zz-same-${run}%`]);
  await app.db.query(`delete from luna_feedback.issue_kinds where key like $1`, [`zz_same_${run}%`]);
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%+${run}@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%+${run}@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, jira: null, diagnosis: { logs: null, ai: new OpenRouterClient({ apiKey: 'k', model: 'google/gemini-3.1-flash-lite', fetchImpl: fakeAi }) } });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

let A: { id: string; ref: string };
let B: { id: string; ref: string };
let C: { id: string; ref: string };
let kind: { id: string; ref: string; title: string };

describe('similar reports', () => {
  beforeAll(async () => {
    A = await post('a');
    B = await post('b', { feedback_text: 'Sleep start recorded 3 hours late, I slept at 11pm', occurred_on: '2026-03-11' });
    C = await post('c', { issue_categories: ['incorrect_duration'], feedback_text: 'Map never loaded after the run' }, 'workout');
  });

  it('lists look-alikes with the reasons they matched, and leaves unrelated reports out', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/feedback/${A.ref}/similar`, headers: appHeaders });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.source.ref).toBe(A.ref);
    const b = s.items.find((i: { id: string }) => i.id === B.id);
    expect(b).toBeDefined();
    expect(b.reasons.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(['feature', 'categories', 'text', 'firmware', 'app', 'platform']));
    expect(b.reasons.find((x: { kind: string }) => x.kind === 'categories').label).toBe('Incorrect sleep');
    expect(b.same_problem).toBe(false);
    expect(s.items.some((i: { id: string }) => i.id === C.id)).toBe(false);
    expect(s.ai_enabled).toBe(true);
  });

  it('marks look-alikes as the same issue, creating the problem with this report as its reference', async () => {
    const noName = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${A.id}/same`, headers: adminHeaders, payload: { submission_ids: [B.ref] } });
    expect(noName.statusCode).toBe(422);
    const unknown = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${A.id}/same`, headers: adminHeaders, payload: { submission_ids: ['LN-99999999'], title: TITLE('x') } });
    expect(unknown.statusCode).toBe(422);
    expect(JSON.stringify(unknown.json())).toContain('LN-99999999');

    const r = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${A.id}/same`, headers: adminHeaders, payload: { submission_ids: [B.ref], title: TITLE('Sleep start recorded late') } });
    expect(r.statusCode).toBe(200);
    kind = r.json().kind;
    expect(kind.ref).toMatch(/^LNK-\d{4,}$/);
    expect(r.json()).toMatchObject({ linked: 2, counts: { count: 2, users: 2 } });

    const detail = (await app.inject({ method: 'GET', url: `/v1/kinds/${kind.ref}?is_test=true&from=2026-01-01&to=2026-12-31`, headers: appHeaders })).json();
    expect(detail.reference_ref).toBe(A.ref);
    expect(detail.count).toBe(2);

    const links = await linksOf(A.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ ref: kind.ref, state: 'linked', source: 'manual', counts: { count: 2 } });
    const again = (await app.inject({ method: 'GET', url: `/v1/feedback/${A.ref}/similar`, headers: appHeaders })).json();
    expect(again.items.find((i: { id: string }) => i.id === B.id).same_problem).toBe(true);
  });
});

describe('suggestions at intake', () => {
  it('proposes the open problem a new report looks like, and a person confirms it', async () => {
    const D = await post('dd', { occurred_on: '2026-03-12' });
    const suggested = await waitFor(async () => (await linksOf(D.id)).find((l) => l.state === 'suggested'));
    expect(suggested).toMatchObject({ ref: kind.ref, source: 'rule' });

    // Suggestions do not count.
    const before = (await app.inject({ method: 'GET', url: `/v1/kinds/${kind.ref}?is_test=true&from=2026-01-01&to=2026-12-31`, headers: appHeaders })).json();
    expect(before.count).toBe(2);

    const ok = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${D.id}/kinds/${kind.ref}/decision`, headers: adminHeaders, payload: { decision: 'confirm' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0]).toMatchObject({ ref: kind.ref, state: 'linked', counts: { count: 3 } });
  });

  it('remembers "not this", even against a diagnosis naming the same problem', async () => {
    const E = await post('eee', { occurred_on: '2026-03-12' });
    await waitFor(async () => (await linksOf(E.id)).find((l) => l.state === 'suggested'));
    const no = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${E.id}/kinds/${kind.id}/decision`, headers: adminHeaders, payload: { decision: 'reject' } });
    expect(no.statusCode).toBe(200);
    expect(no.json().items).toHaveLength(0);

    // A later diagnosis suggests the very same problem: the rejection stands.
    const kinds = new KindsService(new KindsRepo(app.db));
    await kinds.applySuggestion(E.id, { title: kind.title, rationale: 'looks the same' }, { feature_key: 'sleep', tags: [], event_codes: [], severity: 'medium' });
    expect(await linksOf(E.id)).toHaveLength(0);
    const row = await app.db.query(`select state from luna_feedback.submission_issue_kinds where submission_id = $1 and kind_id = $2`, [E.id, kind.id]);
    expect(row.rows[0].state).toBe('rejected');
  });

  it('tells the CX tool what a customer\'s problem most likely is', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/cx/feedback/sleep', headers: cxHeaders, payload: {
      is_test: true, is_positive: false, occurred_on: '2026-03-13', device_serial: 'R2NSAME0001', issue_categories: ['incorrect_sleep'],
      feedback_text: LATE, client: { platform: 'ios', app_version: '2.4.0', firmware_version: '1.9.3' }, cx: { ref: `zz-same-${run}-1` },
    } });
    expect(r.statusCode).toBe(201);
    expect(r.json().likely_problem).toMatchObject({ ref: kind.ref, title: kind.title, report_count: 3 });
    expect(r.json().problems).toEqual([]);
  });

  it('suggests nothing for a report that does not look like any open problem', async () => {
    const F = await post('ffff', { issue_categories: ['vitals_not_recorded'], feedback_text: 'Heart rate graph empty all night', occurred_on: '2026-03-14' });
    await sleep(500);
    expect(await linksOf(F.id)).toHaveLength(0);
  });
});

describe('from the problem\'s side', () => {
  it('finds more instances and adds them', async () => {
    const G = await post('ggggg', { occurred_on: '2026-03-15', feedback_text: 'Recorded sleep start three hours late again' });
    const r = await app.inject({ method: 'GET', url: `/v1/kinds/${kind.ref}/similar?is_test=true`, headers: appHeaders });
    expect(r.statusCode).toBe(200);
    const g = r.json().items.find((i: { id: string }) => i.id === G.id);
    expect(g).toBeDefined();
    expect(g.closest_ref).toMatch(/^LN-/);
    // Already-linked reports are not offered again.
    expect(r.json().items.some((i: { id: string }) => i.id === A.id)).toBe(false);

    const add = await app.inject({ method: 'POST', url: `/v1/admin/kinds/${kind.ref}/reports`, headers: adminHeaders, payload: { submission_ids: [G.ref] } });
    expect(add.statusCode).toBe(200);
    expect((await linksOf(G.id)).map((l) => [l.ref, l.state])).toEqual([[kind.ref, 'linked']]);
  });

  it('sets the reference report', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/v1/admin/kinds/${kind.id}`, headers: adminHeaders, payload: { reference_submission_id: B.ref } });
    expect(r.statusCode).toBe(200);
    expect(r.json().reference_submission_id).toBe(B.id);
  });

  it('merges a duplicate problem into this one', async () => {
    const H = await post('hhhhhh', { issue_categories: ['incorrect_sleep_stage'], feedback_text: 'Deep sleep missing', occurred_on: '2026-03-16' });
    const dup = (await app.inject({ method: 'POST', url: `/v1/admin/submissions/${H.id}/kinds`, headers: adminHeaders, payload: { title: TITLE('Sleep begins late on the timeline') } })).json().items[0];

    expect((await app.inject({ method: 'POST', url: `/v1/admin/kinds/${kind.id}/merge`, headers: adminHeaders, payload: { into: kind.ref } })).statusCode).toBe(422);
    const m = await app.inject({ method: 'POST', url: `/v1/admin/kinds/${dup.ref}/merge`, headers: adminHeaders, payload: { into: kind.ref } });
    expect(m.statusCode).toBe(200);
    expect(m.json().aliases).toContain(TITLE('Sleep begins late on the timeline'));

    expect((await linksOf(H.id)).map((l) => l.ref)).toEqual([kind.ref]);
    const gone = (await app.inject({ method: 'GET', url: `/v1/kinds/${dup.ref}`, headers: appHeaders })).json();
    expect(gone).toMatchObject({ is_archived: true, merged_into_ref: kind.ref });
    const list = (await app.inject({ method: 'GET', url: '/v1/kinds?is_test=true&from=2026-01-01&to=2026-12-31', headers: appHeaders })).json().items;
    expect(list.some((k: { id: string }) => k.id === dup.kind_id)).toBe(false);

    // The model naming the merged-away problem lands on the survivor.
    const I = await post('iiiiiii', { issue_categories: ['sleep_not_recorded'], feedback_text: 'nothing alike', occurred_on: '2026-05-30' });
    const kinds = new KindsService(new KindsRepo(app.db));
    const landed = await kinds.applySuggestion(I.id, { title: TITLE('sleep begins late on the timeline.'), rationale: '' }, { feature_key: 'sleep', tags: [], event_codes: [], severity: null });
    expect(landed?.id).toBe(kind.id);
  });
});

describe('AI same-issue check', () => {
  it('labels the top look-alikes, keeps only verdicts about reports it was sent, and remembers them', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${A.id}/similar/ai-check`, headers: adminHeaders });
    expect(r.statusCode).toBe(200);
    expect(modelCalls).toBe(1);
    const body = r.json();
    expect(body.cost_usd).toBeCloseTo(0.0004, 6);
    const judged = body.items.filter((i: { ai: unknown }) => i.ai);
    expect(judged.length).toBe(body.items.length);
    expect(judged[0].ai).toMatchObject({ verdict: 'same', reason: 'Same late sleep start.' });

    const stored = await app.db.query(`select verdicts from luna_feedback.similarity_checks where submission_id = $1`, [A.id]);
    expect(stored.rows[0].verdicts.some((v: { ref: string }) => v.ref === 'LN-99999999')).toBe(false);
    const later = (await app.inject({ method: 'GET', url: `/v1/feedback/${A.id}/similar`, headers: appHeaders })).json();
    expect(later.checked_at).toMatch(/^\d{4}-/);
    expect(later.items[0].ai).not.toBeNull();
  });
});

describe('who may do what', () => {
  let cxCookie = '';
  let bizCookie = '';
  beforeAll(async () => {
    const make = async (who: string, role: string) => {
      const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: `${who}+${run}@${DOMAIN}`, role } })).json().generated_password;
      const login = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: `${who}+${run}@${DOMAIN}`, password: pass } });
      return String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    };
    cxCookie = await make('cx', 'cx');
    bizCookie = await make('biz', 'business');
  });

  it('CX can suggest a problem but not confirm, mark as same or merge; business cannot suggest', async () => {
    const J = await post('jjjjjjjj', { issue_categories: ['vitals_not_recorded'], feedback_text: 'Heart rate missing', occurred_on: '2026-06-01' });
    const s = await app.inject({ method: 'POST', url: `/v1/admin/submissions/${J.id}/kinds/suggest`, headers: { ...dash, cookie: cxCookie }, payload: { kind_id: kind.ref } });
    expect(s.statusCode).toBe(200);
    expect(s.json().items[0]).toMatchObject({ ref: kind.ref, state: 'suggested', source: 'manual' });

    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${J.id}/kinds/${kind.id}/decision`, headers: { ...dash, cookie: cxCookie }, payload: { decision: 'confirm' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${J.id}/same`, headers: { ...dash, cookie: cxCookie }, payload: { submission_ids: [A.id], kind_id: kind.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/kinds/${kind.id}/merge`, headers: { ...dash, cookie: cxCookie }, payload: { into: kind.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${J.id}/kinds/suggest`, headers: { ...dash, cookie: bizCookie }, payload: { kind_id: kind.ref } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/submissions/${A.id}/similar/ai-check`, headers: { ...dash, cookie: bizCookie } })).statusCode).toBe(403);

    // A suggestion from CX does not demote a confirmed link.
    await app.inject({ method: 'POST', url: `/v1/admin/submissions/${A.id}/kinds/suggest`, headers: { ...dash, cookie: cxCookie }, payload: { kind_id: kind.ref } });
    expect((await linksOf(A.id))[0]).toMatchObject({ ref: kind.ref, state: 'linked' });
  });
});
