import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PAGES } from '../../pages/generated.js';
import { AppError } from '../../lib/errors.js';
import { DASHBOARD_HEADER } from '../../plugins/auth.js';
import {
  SESSION_COOKIE, clearedSessionCookie, makeSessionToken, readCookie, sessionCookie, verifySessionToken,
} from '../../plugins/dashboardSession.js';

interface PageDeps {
  dashboardKey: string;
  sessionSecret: string;
  sessionDays: number;
}

const LoginBody = z.object({ key: z.string().min(1).max(512) }).strict();

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
  app.get('/', async (_req, reply) => reply.redirect('/docs', 302));

  /** Is the caller signed in? Read by the dashboard on load. */
  app.get('/dashboard/session', async (req) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const exp = token ? verifySessionToken(deps.sessionSecret, token) : null;
    return exp ? { authenticated: true, expires_at: new Date(exp).toISOString() } : { authenticated: false };
  });

  /** Exchange the dashboard key for a signed, HttpOnly session cookie. */
  app.post('/dashboard/login', async (req, reply) => {
    if (req.headers[DASHBOARD_HEADER] !== 'dashboard') throw AppError.forbidden('Missing dashboard header');
    if (tooManyFailures(req.ip)) throw new AppError(429, 'FORBIDDEN', 'Too many attempts. Try again in a few minutes.');
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation([{ path: 'key', message: 'key is required' }]);
    if (!safeEqual(parsed.data.key.trim(), deps.dashboardKey)) {
      recordFailure(req.ip);
      throw AppError.unauthorized('That key was not accepted');
    }
    const { token, expiresAt } = makeSessionToken(deps.sessionSecret, ttlMs);
    reply.header('set-cookie', sessionCookie(token, deps.sessionDays * 86_400, isSecure(req)));
    return { authenticated: true, expires_at: new Date(expiresAt).toISOString() };
  });

  app.post('/dashboard/logout', async (req, reply) => {
    reply.header('set-cookie', clearedSessionCookie(isSecure(req)));
    return { authenticated: false };
  });
}
