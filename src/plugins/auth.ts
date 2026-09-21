import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { can, type Actor, type Permission } from '../lib/actor.js';
import { SESSION_COOKIE, readCookie, verifySessionToken, verifySuperSessionToken, verifyUserSessionToken } from './dashboardSession.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function header(req: { headers: Record<string, unknown> }, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** Routes that serve HTML pages or handle the dashboard sign-in. Data behind them still needs auth. */
export const PUBLIC_PATHS = new Set([
  '/', '/healthz', '/docs',
  '/dashboard', '/dashboard/diagnosis', '/dashboard/analytics', '/dashboard/kinds', '/dashboard/users',
  '/dashboard/login', '/dashboard/logout', '/dashboard/session', '/dashboard/bootstrap',
]);

/** Header the dashboard sends on every fetch. Cross-site forms cannot set it, which blocks CSRF on the cookie session. */
export const DASHBOARD_HEADER = 'x-requested-with';

/** Resolves a signed-in user id into the actor for this request. */
export interface ActorResolver {
  actorFor(userId: string): Promise<Actor | null>;
  /** Password timestamp, so rotating a password ends that account's other sessions. */
  passwordEpochFor(userId: string): Promise<number | null>;
  /**
   * Whether an enabled admin account exists.
   *
   * With the master key switched off, DASHBOARD_KEY keeps working until one does —
   * deliberately keyed on *admin* rather than on any account at all, because adding a QC or
   * developer first would otherwise kill the key while leaving nobody able to manage people.
   */
  anyAdminExists(): Promise<boolean>;
  /** Optional label for master-key sessions, from SUPERADMIN_EMAIL. */
  superAdminEmail(): string | null;
}

/**
 * public paths          → open
 * user session cookie   → the signed-in account's own role
 * legacy key session    → admin, but only while no account exists
 * /v1/admin/**          → x-admin-key, or a session whose role allows the route
 * everything else /v1   → x-api-key (admin key also accepted)
 */
export function registerAuth(
  app: FastifyInstance,
  keys: { app: string; admin: string; sessionSecret: string; cronSecret?: string; keyLogin?: boolean },
  users?: ActorResolver,
) {
  app.decorateRequest('actor', undefined);

  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(url) || /^\/dashboard\/(?:submissions|kinds)\/[^/]+$/.test(url)) return;

    const apiKey = header(req, 'x-api-key');
    const adminKey = header(req, 'x-admin-key');

    let actor: Actor | undefined;
    if (adminKey !== undefined && safeEqual(adminKey, keys.admin)) {
      actor = { id: null, email: null, name: null, role: 'admin', via: 'admin_key' };
    }

    // Vercel cron calls GET /v1/admin/diagnoses/run-pending with "Authorization: Bearer <CRON_SECRET>".
    if (!actor && keys.cronSecret && url === '/v1/admin/diagnoses/run-pending') {
      const auth = header(req, 'authorization');
      if (auth && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), keys.cronSecret)) {
        actor = { id: null, email: null, name: null, role: 'admin', via: 'cron' };
      }
    }

    if (!actor && header(req, DASHBOARD_HEADER) === 'dashboard') {
      actor = await sessionActor(req, keys.sessionSecret, keys.keyLogin !== false, users);
    }

    if (actor) req.actor = actor;

    if (url.startsWith('/v1/admin/')) {
      if (!actor) throw AppError.unauthorized('Missing or invalid x-admin-key');
      return;
    }
    if (actor) return;
    if (apiKey === undefined || !safeEqual(apiKey, keys.app)) throw AppError.unauthorized('Missing or invalid x-api-key');
    req.actor = { id: null, email: null, name: null, role: 'business', via: 'app_key' };
  });
}

async function sessionActor(req: FastifyRequest, secret: string, keyLogin: boolean, users?: ActorResolver): Promise<Actor | undefined> {
  const token = readCookie(header(req, 'cookie'), SESSION_COOKIE);
  if (!token) return undefined;

  const session = verifyUserSessionToken(secret, token);
  if (session && users) {
    // The role comes from the database on every request, so a demotion or a disable
    // takes effect immediately rather than when the cookie happens to expire.
    const epoch = await users.passwordEpochFor(session.userId);
    if (epoch === null || epoch !== session.passwordEpoch) return undefined;
    return (await users.actorFor(session.userId)) ?? undefined;
  }

  // Master-key session. While DASHBOARD_KEY_LOGIN is on it is always an admin; with it off it
  // lasts only until an admin account exists to take over.
  if (verifySessionToken(secret, token) !== null || verifySuperSessionToken(secret, token) !== null) {
    if (!keyLogin && users && (await users.anyAdminExists())) return undefined;
    return { id: null, email: users?.superAdminEmail() ?? null, name: 'Master key', role: 'admin', via: 'session' };
  }
  return undefined;
}

/**
 * Guard for a route that only some roles may use.
 * Key-based callers (admin key, cron) are admins and pass everything.
 */
export function requirePermission(permission: Permission) {
  return async (req: FastifyRequest) => {
    if (!can(req.actor, permission)) {
      const role = req.actor?.role ?? 'unknown';
      throw AppError.forbidden(`Your role (${role}) cannot do this`);
    }
  };
}
