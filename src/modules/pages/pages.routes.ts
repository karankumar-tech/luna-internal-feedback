import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PAGES } from '../../pages/generated.js';
import { AppError } from '../../lib/errors.js';
import { DASHBOARD_HEADER } from '../../plugins/auth.js';
import {
  SESSION_COOKIE, clearedSessionCookie, makeSessionToken, makeSuperSessionToken, makeUserSessionToken,
  readCookie, sessionCookie, verifySessionToken, verifySuperSessionToken, verifyUserSessionToken,
} from '../../plugins/dashboardSession.js';
import type { UsersService } from '../users/users.service.js';

interface PageDeps {
  dashboardKey: string;
  sessionSecret: string;
  sessionDays: number;
  /** Master key: while true, DASHBOARD_KEY signs in as an admin however many accounts exist. */
  keyLogin: boolean;
  /** Absent only in tests that do not exercise accounts. */
  users?: UsersService;
}

/** Either the shared key (only while no account exists) or an email and password. */
const LoginBody = z.union([
  z.object({ key: z.string().min(1).max(512) }).strict(),
  z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }).strict(),
]);

const BootstrapBody = z.object({
  /** The shared DASHBOARD_KEY: the only thing that proves the caller is meant to be here. */
  key: z.string().min(1).max(512),
  email: z.string().trim().email().max(254),
  name: z.string().trim().max(120).optional(),
  password: z.string().min(1).max(200),
}).strict();

/** Small in-memory brake on password guessing: 8 failures per IP per 10 minutes. */
const failures = new Map<string, { count: number; resetAt: number }>();
function tooManyFailures(ip: string, now = Date.now()): boolean {
  const f = failures.get(ip);
  if (!f || f.resetAt < now) return false;
  return f.count >= 8;
}
function recordFailure(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + 10 * 60_000 });
  else f.count += 1;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Serves the bundled HTML pages and the dashboard sign-in.
 * Page content comes from src/pages/*.html via `npm run pages:embed`, so the
 * serverless bundle never reads files at runtime.
 */
export function registerPageRoutes(app: FastifyInstance, deps: PageDeps) {
  const html = (body: string) => async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-cache').send(body);

  const isSecure = (req: FastifyRequest) => req.protocol === 'https';
  const ttlMs = deps.sessionDays * 86_400_000;

  app.get('/docs', html(PAGES.docs));
  app.get('/dashboard', html(PAGES.dashboard));
  app.get('/dashboard/submissions/:id', html(PAGES.submission));
  app.get('/dashboard/diagnosis', html(PAGES.diagnosis));
  app.get('/dashboard/analytics', html(PAGES.analytics));
  app.get('/dashboard/kinds', html(PAGES.kinds));
  app.get('/dashboard/kinds/:id', html(PAGES.kinds));
  app.get('/dashboard/users', html(PAGES.users));
  app.get('/', async (_req, reply) => reply.redirect('/docs', 302));

  /** Is the caller signed in, and who are they? Read by every dashboard page on load. */
  app.get('/dashboard/session', async (req) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const needsBootstrap = deps.users ? await deps.users.needsBootstrap() : false;
    // `key_login` tells the sign-in page whether to offer the key at all.
    const base = { needs_bootstrap: needsBootstrap, accounts_enabled: !needsBootstrap, key_login: deps.keyLogin };

    if (token && deps.users) {
      const session = verifyUserSessionToken(deps.sessionSecret, token);
      if (session) {
        const actor = await deps.users.actorFor(session.userId);
        const password = await deps.users.passwordState(session.userId);
        if (actor) {
          return {
            ...base, authenticated: true, expires_at: new Date(session.expiresAt).toISOString(),
            user: { id: actor.id, email: actor.email, name: actor.name, role: actor.role },
            password,
          };
        }
      }
    }

    // Master-key session: always valid while DASHBOARD_KEY_LOGIN is on, otherwise only until
    // an admin account exists to take over.
    const exp = token
      ? verifySessionToken(deps.sessionSecret, token) ?? verifySuperSessionToken(deps.sessionSecret, token)
      : null;
    if (exp !== null && (deps.keyLogin || needsBootstrap)) {
      return {
        ...base, authenticated: true, expires_at: new Date(exp).toISOString(),
        user: { id: null, email: deps.users?.superAdminEmail ?? null, name: 'Master key', role: 'admin' },
        password: { must_change: false, reason: null, age_days: 0 },
      };
    }
    return { ...base, authenticated: false };
  });

  /** Exchange an email and password — or, before any account exists, the dashboard key — for a session cookie. */
  app.post('/dashboard/login', async (req, reply) => {
    if (req.headers[DASHBOARD_HEADER] !== 'dashboard') throw AppError.forbidden('Missing dashboard header');
    if (tooManyFailures(req.ip)) throw new AppError(429, 'FORBIDDEN', 'Too many attempts. Try again in a few minutes.');
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation([{ path: 'email', message: 'send email and password' }]);

    if ('email' in parsed.data) {
      if (!deps.users) throw AppError.validation([{ path: 'email', message: 'accounts are not configured on this server' }]);

      // Master key by email: SUPERADMIN_EMAIL with DASHBOARD_KEY as the password. Only when no
      // real account owns that email, so a genuine password always wins.
      const byMasterKey = deps.users.isSuperAdmin(parsed.data.email)
        && safeEqual(parsed.data.password, deps.dashboardKey)
        && !(await deps.users.hasAccount(parsed.data.email));
      if (byMasterKey) {
        const email = parsed.data.email.trim().toLowerCase();
        await deps.users.logSuperAdminSignIn(email);
        const { token, expiresAt } = makeSuperSessionToken(deps.sessionSecret, ttlMs);
        reply.header('set-cookie', sessionCookie(token, deps.sessionDays * 86_400, isSecure(req)));
        return {
          authenticated: true, expires_at: new Date(expiresAt).toISOString(),
          user: { id: null, email, name: 'Master key', role: 'admin' },
          must_change_password: false, reason: null,
        };
      }

      let result;
      try {
        result = await deps.users.signIn(parsed.data.email, parsed.data.password);
      } catch (err) {
        recordFailure(req.ip);
        throw err;
      }
      const { token, expiresAt } = makeUserSessionToken(deps.sessionSecret, result.user.id, new Date(result.user.password_set_at), ttlMs);
      reply.header('set-cookie', sessionCookie(token, deps.sessionDays * 86_400, isSecure(req)));
      return {
        authenticated: true, expires_at: new Date(expiresAt).toISOString(),
        user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role },
        must_change_password: result.must_change_password, reason: result.reason,
      };
    }

    // With the master key off, the key is a bootstrap credential only: once an admin
    // account exists to take over, it is refused.
    if (!deps.keyLogin && deps.users && (await deps.users.anyAdminExists())) {
      throw AppError.forbidden('The shared key no longer works. Sign in with your email and password, or ask an admin to add you.');
    }
    if (!safeEqual(parsed.data.key.trim(), deps.dashboardKey)) {
      recordFailure(req.ip);
      throw AppError.unauthorized('That key was not accepted');
    }
    const { token, expiresAt } = makeSessionToken(deps.sessionSecret, ttlMs);
    reply.header('set-cookie', sessionCookie(token, deps.sessionDays * 86_400, isSecure(req)));
    return {
      authenticated: true, expires_at: new Date(expiresAt).toISOString(),
      user: { id: null, email: deps.users?.superAdminEmail ?? null, name: 'Master key', role: 'admin' },
      must_change_password: false, reason: null,
    };
  });

  /**
   * Creates the very first admin. Open by necessity — there is nobody to authorise it — but
   * only while the table is empty, and it needs the dashboard key as proof of access.
   */
  app.post('/dashboard/bootstrap', async (req, reply) => {
    if (req.headers[DASHBOARD_HEADER] !== 'dashboard') throw AppError.forbidden('Missing dashboard header');
    if (!deps.users) throw AppError.validation([{ path: 'email', message: 'accounts are not configured on this server' }]);
    if (tooManyFailures(req.ip)) throw new AppError(429, 'FORBIDDEN', 'Too many attempts. Try again in a few minutes.');

    const parsed = BootstrapBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation([{ path: 'email', message: 'send key, email, password and optionally name' }]);
    if (!safeEqual(parsed.data.key.trim(), deps.dashboardKey)) {
      recordFailure(req.ip);
      throw AppError.unauthorized('That key was not accepted');
    }
    if (!(await deps.users.needsBootstrap())) throw AppError.forbidden('Accounts already exist; ask an admin to add you.');

    const user = await deps.users.bootstrapFirstAdmin(parsed.data);
    const { token, expiresAt } = makeUserSessionToken(deps.sessionSecret, user.id, new Date(user.password_set_at), ttlMs);
    reply.header('set-cookie', sessionCookie(token, deps.sessionDays * 86_400, isSecure(req)));
    return { authenticated: true, expires_at: new Date(expiresAt).toISOString(), user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post('/dashboard/logout', async (req, reply) => {
    reply.header('set-cookie', clearedSessionCookie(isSecure(req)));
    return { authenticated: false };
  });
}
