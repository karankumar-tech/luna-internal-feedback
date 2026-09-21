import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/build-app.js';
import { loadConfig } from '../../src/config.js';

/**
 * Accounts, roles and password rotation.
 *
 * Runs against its own email domain and removes every account it creates, because the
 * dashboard_users table is shared with whatever the real deployment has in it.
 */
const DOMAIN = 'luna-users-test.invalid';
const run = `${Date.now()}`;
const email = (who: string) => `${who}+${run}@${DOMAIN}`;

let app: App;
const cfg = loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', PASSWORD_HISTORY_DEPTH: '3' });
const adminHeaders = { 'x-admin-key': cfg.ADMIN_API_KEY, 'content-type': 'application/json' };
const dash = { 'x-requested-with': 'dashboard', 'content-type': 'application/json' };

/** Signs in and returns the session cookie plus the login response. */
async function signIn(address: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password } });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return { res, cookie, body: res.json() };
}
const asUser = (cookie: string) => ({ ...dash, cookie });

async function cleanup() {
  await app.db.query(`delete from luna_feedback.dashboard_users where email like $1`, [`%@${DOMAIN}`]);
  await app.db.query(`delete from luna_feedback.dashboard_user_events where target like $1 or actor like $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  app = buildApp({ config: cfg, logger: false, diagnosis: { logs: null, ai: null }, jira: null });
  await app.ready();
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });

describe('creating accounts', () => {
  it('generates a password when none is given and forces a change at first sign-in', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email('qc'), role: 'qc', name: 'QC Person' } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.user.role).toBe('qc');
    expect(body.user.must_change).toBe(true);
    expect(body.generated_password).toMatch(/^[A-Za-z2-9]{14}$/);
    // The hash is never exposed, in any shape.
    expect(JSON.stringify(body.user)).not.toContain('scrypt');
    expect(body.user.password_hash).toBeUndefined();
  });

  it('lowercases the email and refuses a duplicate', async () => {
    const address = email('Mixed').toUpperCase();
    const first = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'business' } });
    expect(first.statusCode).toBe(201);
    expect(first.json().user.email).toBe(address.toLowerCase());

    const again = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address.toLowerCase(), role: 'business' } });
    expect(again.statusCode).toBe(422);
    expect(JSON.stringify(again.json())).toContain('already exists');
  });

  it('refuses a weak password an admin tries to set', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email('weak'), role: 'business', password: 'password123' } });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('easy to guess');
  });

  it('refuses an unknown role and a malformed email', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email('r'), role: 'wizard' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: 'not-an-email', role: 'qc' } })).statusCode).toBe(422);
  });
});

describe('signing in', () => {
  const address = email('signin');
  let issued = '';

  beforeAll(async () => {
    issued = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'developer' } })).json().generated_password;
  });

  it('accepts the issued password and says the password must change', async () => {
    const { res, body, cookie } = await signIn(address, issued);
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ authenticated: true, must_change_password: true, reason: 'admin_issued' });
    expect(body.user.role).toBe('developer');
    expect(cookie).toContain('luna_dash=');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: 'definitely-not-it-1' } });
    const missing = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: email('ghost'), password: 'definitely-not-it-1' } });
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(missing.json().error.message);
  });

  it('refuses without the dashboard header, which is what blocks cross-site posts', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/login', headers: { 'content-type': 'application/json' }, payload: { email: address, password: issued } });
    expect(r.statusCode).toBe(403);
  });

  it('reports the signed-in identity and permissions at /v1/me', async () => {
    const { cookie } = await signIn(address, issued);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(cookie) })).json();
    expect(me).toMatchObject({ email: address, role: 'developer', via: 'session' });
    expect(me.password.must_change).toBe(true);
    expect(me.permissions).toMatchObject({
      manage_users: false, manage_jira: false, manage_triage: false,
      manage_kinds: true, run_diagnosis: true, review_diagnosis: true,
    });
  });
});

describe('role permissions', () => {
  let businessCookie = '';
  let qcCookie = '';
  let submissionId = '';

  beforeAll(async () => {
    const b = email('biz');
    const q = email('qc2');
    const bPass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: b, role: 'business' } })).json().generated_password;
    const qPass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: q, role: 'qc' } })).json().generated_password;
    businessCookie = (await signIn(b, bPass)).cookie;
    qcCookie = (await signIn(q, qPass)).cookie;

    submissionId = (await app.inject({
      method: 'POST', url: '/v1/feedback/home',
      headers: { 'x-api-key': cfg.APP_API_KEY, 'content-type': 'application/json' },
      payload: { is_test: true, is_positive: false, occurred_on: '2026-09-01', user_id: 900077, email: `sub+${run}@${DOMAIN}`, issue_categories: ['wrong_peak_score'] },
    })).json().id;
  });

  afterAll(async () => {
    await app.db.query(`delete from luna_feedback.submissions where email like $1`, [`%@${DOMAIN}`]);
  });

  it('lets everyone read', async () => {
    for (const cookie of [businessCookie, qcCookie]) {
      expect((await app.inject({ method: 'GET', url: '/v1/feedback?limit=1', headers: asUser(cookie) })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/analytics/overview', headers: asUser(cookie) })).statusCode).toBe(200);
    }
  });

  it('stops business from changing triage, and lets QC do it', async () => {
    const denied = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${submissionId}`, headers: asUser(businessCookie), payload: { status: 'triaged' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('business');

    const allowed = await app.inject({ method: 'PATCH', url: `/v1/admin/submissions/${submissionId}`, headers: asUser(qcCookie), payload: { status: 'triaged' } });
    expect(allowed.statusCode).toBe(200);
    // The actor is recorded by email, not by "session".
    expect(allowed.json().status_changed_by).toContain('@');
  });

  it('stops everyone but an admin from managing people', async () => {
    for (const cookie of [businessCookie, qcCookie]) {
      expect((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: asUser(cookie) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/v1/admin/users', headers: asUser(cookie), payload: { email: email('sneaky'), role: 'admin' } })).statusCode).toBe(403);
    }
  });

  it('stops business from deleting test data', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/v1/admin/test-data?confirm=delete', headers: asUser(businessCookie) })).statusCode).toBe(403);
  });

  it('keeps the admin key working for automation regardless of roles', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: adminHeaders })).statusCode).toBe(200);
  });
});

describe('rotating a password', () => {
  const address = email('rotate');
  let issued = '';
  let cookie = '';

  beforeAll(async () => {
    issued = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'qc' } })).json().generated_password;
    cookie = (await signIn(address, issued)).cookie;
  });

  it('refuses a new password that breaks the rules or repeats the current one', async () => {
    const weak = await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(cookie), payload: { current_password: issued, new_password: 'qwerty12345' } });
    expect(weak.statusCode).toBe(422);

    const same = await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(cookie), payload: { current_password: issued, new_password: issued } });
    expect(same.statusCode).toBe(422);
    expect(JSON.stringify(same.json())).toContain('different from your current');
  });

  it('refuses when the current password is wrong', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(cookie), payload: { current_password: 'not-the-one-1', new_password: 'a fresh secret 12' } });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('current password');
  });

  it('changes it, clears must_change, and refuses to reuse it later', async () => {
    const first = 'first rotation 123';
    const changed = await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(cookie), payload: { current_password: issued, new_password: first } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user.must_change).toBe(false);

    // The new password works; the old one does not.
    expect((await signIn(address, first)).res.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: issued } })).statusCode).toBe(401);

    const next = (await signIn(address, first)).cookie;
    const reuse = await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(next), payload: { current_password: first, new_password: first } });
    expect(reuse.statusCode).toBe(422);

    // Move forward twice more, then try to come back to the first one: history blocks it.
    const second = 'second rotation 45';
    await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(next), payload: { current_password: first, new_password: second } });
    const afterSecond = (await signIn(address, second)).cookie;
    const back = await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(afterSecond), payload: { current_password: second, new_password: first } });
    expect(back.statusCode).toBe(422);
    expect(JSON.stringify(back.json())).toContain('last 3 passwords');
  });

  it('signs out the account’s other sessions', async () => {
    const address2 = email('sessions');
    const pass = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address2, role: 'qc' } })).json().generated_password;
    const oldCookie = (await signIn(address2, pass)).cookie;
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(oldCookie) })).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(oldCookie), payload: { current_password: pass, new_password: 'brand new one 99' } });
    // That cookie was minted against the previous password timestamp, so it no longer resolves.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(oldCookie) })).statusCode).toBe(401);
  });
});

describe('admin overrides', () => {
  it('issues a new password, returns it once, and forces a change', async () => {
    const address = email('override');
    const created = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'business' } })).json();
    const cookie = (await signIn(address, created.generated_password)).cookie;
    await app.inject({ method: 'POST', url: '/v1/me/password', headers: asUser(cookie), payload: { current_password: created.generated_password, new_password: 'settled password 7' } });

    const id = created.user.id;
    const reset = await app.inject({ method: 'POST', url: `/v1/admin/users/${id}/password`, headers: adminHeaders, payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().password).toMatch(/^[A-Za-z2-9]{14}$/);
    expect(reset.json().user.must_change).toBe(true);

    // The password they had chosen stops working; the issued one works and demands a change.
    expect((await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: 'settled password 7' } })).statusCode).toBe(401);
    expect((await signIn(address, reset.json().password)).body.must_change_password).toBe(true);
  });

  it('disables and re-enables an account', async () => {
    const address = email('disable');
    const created = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'qc' } })).json();
    const cookie = (await signIn(address, created.generated_password)).cookie;

    await app.inject({ method: 'PATCH', url: `/v1/admin/users/${created.user.id}`, headers: adminHeaders, payload: { is_disabled: true } });
    // Existing sessions stop resolving, and a fresh sign-in is refused with a reason.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(cookie) })).statusCode).toBe(401);
    const blocked = await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: created.generated_password } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toContain('disabled');

    await app.inject({ method: 'PATCH', url: `/v1/admin/users/${created.user.id}`, headers: adminHeaders, payload: { is_disabled: false } });
    expect((await signIn(address, created.generated_password)).res.statusCode).toBe(200);
  });

  it('changes a role, and the new role takes effect on the next request', async () => {
    const address = email('promote');
    const created = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'business' } })).json();
    const cookie = (await signIn(address, created.generated_password)).cookie;
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(cookie) })).json().permissions.manage_jira).toBe(false);

    await app.inject({ method: 'PATCH', url: `/v1/admin/users/${created.user.id}`, headers: adminHeaders, payload: { role: 'qc' } });
    // Same cookie: the role is read from the database each time, not carried in the token.
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(cookie) })).json();
    expect(me.role).toBe('qc');
    expect(me.permissions.manage_jira).toBe(true);
  });

  it('records what happened in the account log', async () => {
    const { items } = (await app.inject({ method: 'GET', url: '/v1/admin/users/events', headers: adminHeaders })).json();
    const mine = items.filter((e: { target: string | null }) => e.target?.includes(DOMAIN));
    expect(mine.some((e: { action: string }) => e.action === 'user_created')).toBe(true);
    expect(mine.some((e: { action: string }) => e.action === 'password_reset')).toBe(true);
    expect(mine.some((e: { action: string }) => e.action === 'sign_in')).toBe(true);
  });

  it('deletes an account', async () => {
    const address = email('delete-me');
    const created = (await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'business' } })).json();
    expect((await app.inject({ method: 'DELETE', url: `/v1/admin/users/${created.user.id}`, headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: created.generated_password } })).statusCode).toBe(401);
  });
});

describe('lockout', () => {
  it('locks an account after repeated failures and says so', async () => {
    const address = email('lock');
    const locked = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCK_MINUTES: '15' }),
      logger: false, db: app.db, diagnosis: { logs: null, ai: null }, jira: null,
    });
    await locked.ready();
    try {
      const created = (await locked.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: address, role: 'business' } })).json();
      for (let i = 0; i < 3; i += 1) {
        await locked.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: 'wrong-one-here-1' } });
      }
      // Even the right password is refused while the lock holds.
      const r = await locked.inject({ method: 'POST', url: '/dashboard/login', headers: dash, payload: { email: address, password: created.generated_password } });
      expect(r.statusCode).toBe(429);
      expect(r.json().error.message).toContain('Try again in');
    } finally { await locked.close(); }
  });
});

describe('the master key', () => {
  // The brake on password guessing counts failures per IP, and the tests above spend that
  // budget on purpose. These are about the key, not the brake, so they come from elsewhere.
  const fromElsewhere = { ...dash, 'x-forwarded-for': '203.0.113.9' };

  // An admin of this suite's own, so the result does not depend on who the shared
  // database already has in it.
  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/v1/admin/users', headers: adminHeaders, payload: { email: email('gatekeeper'), role: 'admin', password: 'gatekeeper pw 5521' } });
  });

  it('signs in as an admin even though accounts exist, while it is switched on', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/login', headers: fromElsewhere, payload: { key: cfg.DASHBOARD_KEY } });
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ role: 'admin', name: 'Master key' });

    const cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: asUser(cookie) })).json();
    expect(me.role).toBe('admin');
    expect(me.permissions.manage_users).toBe(true);
    // No account behind it, so nothing to rotate.
    expect(me.password.must_change).toBe(false);
  });

  it('reports itself on the session endpoint so the page can offer it', async () => {
    const s = (await app.inject({ method: 'GET', url: '/dashboard/session' })).json();
    expect(s.key_login).toBe(true);
    expect(s.needs_bootstrap).toBe(false);
  });

  it('cannot be used to create another first admin once one exists', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/bootstrap', headers: fromElsewhere, payload: { key: cfg.DASHBOARD_KEY, email: email('second-first'), password: 'another admin 123' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toContain('already exist');
  });

  it('is refused once DASHBOARD_KEY_LOGIN is off and an admin exists', async () => {
    const off = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', DASHBOARD_KEY_LOGIN: 'false' }),
      logger: false, db: app.db, diagnosis: { logs: null, ai: null }, jira: null,
    });
    await off.ready();
    try {
      const r = await off.inject({ method: 'POST', url: '/dashboard/login', headers: { ...dash, 'x-forwarded-for': '203.0.113.10' }, payload: { key: cfg.DASHBOARD_KEY } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.message).toContain('email and password');
      expect((await off.inject({ method: 'GET', url: '/dashboard/session' })).json().key_login).toBe(false);
    } finally { await off.close(); }
  });

  it('still works with it off while no admin exists, so a fresh deployment is reachable', async () => {
    const off = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', DASHBOARD_KEY_LOGIN: 'false' }),
      logger: false, db: app.db, diagnosis: { logs: null, ai: null }, jira: null,
    });
    await off.ready();
    // Every admin temporarily disabled: the key has to come back, or nobody can get in.
    await app.db.query(`update luna_feedback.dashboard_users set is_disabled = true where role = 'admin'`);
    try {
      const r = await off.inject({ method: 'POST', url: '/dashboard/login', headers: { ...dash, 'x-forwarded-for': '203.0.113.11' }, payload: { key: cfg.DASHBOARD_KEY } });
      expect(r.statusCode).toBe(200);
      expect((await off.inject({ method: 'GET', url: '/dashboard/session' })).json().needs_bootstrap).toBe(true);
    } finally {
      await app.db.query(`update luna_feedback.dashboard_users set is_disabled = false where role = 'admin'`);
      await off.close();
    }
  });
});

describe('SUPERADMIN_EMAIL', () => {
  const superEmail = 'super+recovery@luna-users-test.invalid';

  it('signs in with the dashboard key as its password and is an admin', async () => {
    const withSuper = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CATEGORY_CACHE_TTL_MS: '0', LOG_LEVEL: 'silent', SUPERADMIN_EMAIL: superEmail }),
      logger: false, db: app.db, diagnosis: { logs: null, ai: null }, jira: null,
    });
    await withSuper.ready();
    try {
      const r = await withSuper.inject({ method: 'POST', url: '/dashboard/login', headers: { ...dash, 'x-forwarded-for': '203.0.113.12' }, payload: { email: superEmail, password: cfg.DASHBOARD_KEY } });
      expect(r.statusCode).toBe(200);
      expect(r.json().user).toMatchObject({ email: superEmail, role: 'admin' });

      const cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      const me = (await withSuper.inject({ method: 'GET', url: '/v1/me', headers: asUser(cookie) })).json();
      expect(me).toMatchObject({ email: superEmail, role: 'admin' });
      expect(me.permissions.manage_users).toBe(true);

      // Wrong password, and an email that is not the configured one, are both refused.
      expect((await withSuper.inject({ method: 'POST', url: '/dashboard/login', headers: { ...dash, 'x-forwarded-for': '203.0.113.13' }, payload: { email: superEmail, password: 'not-the-key-1' } })).statusCode).toBe(401);
      expect((await withSuper.inject({ method: 'POST', url: '/dashboard/login', headers: { ...dash, 'x-forwarded-for': '203.0.113.14' }, payload: { email: email('other'), password: cfg.DASHBOARD_KEY } })).statusCode).toBe(401);
    } finally { await withSuper.close(); }
  });

  it('is not honoured when it is not configured', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/login', headers: { ...dash, 'x-forwarded-for': '203.0.113.15' }, payload: { email: superEmail, password: cfg.DASHBOARD_KEY } });
    expect(r.statusCode).toBe(401);
  });
});
