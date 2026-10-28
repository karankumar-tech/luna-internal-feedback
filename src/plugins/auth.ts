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
  '/', '/health', '/healthz', '/docs',
  '/dashboard', '/dashboard/report', '/dashboard/diagnosis', '/dashboard/analytics', '/dashboard/kinds', '/dashboard/users', '/dashboard/attention', '/dashboard/settings', '/dashboard/benchmarks', '/dashboard/sprints',
  '/dashboard/login', '/dashboard/logout', '/dashboard/session', '/dashboard/bootstrap',
  // Brand assets: the logo in every header and the icons browsers fetch on their own.
  '/logo.png', '/mark.png', '/favicon.png', '/favicon.ico', '/apple-touch-icon.png',
]);

/**
 * Detail pages (a tester's progress among them), the short share links (/i/LN-00042, /k/LNK-0007, /b/BM-0007, /s/SPR-202610-01)
 * that redirect to them, the pages' scripts, and S3 screenshot links (/v1/screenshots/s3-<uuid>, open like an ImageKit link).
 */
const PUBLIC_PAGE = /^\/(?:dashboard\/(?:submissions|kinds|benchmarks|benchmarks\/progress|sprints|assets)|i|k|b|s|v1\/screenshots)\/[^/]+$/;

/** What the CX tool's key may call: its own routes, plus the form schema and screenshot uploads (S3 links or ImageKit credentials). */
function cxKeyMayCall(url: string): boolean {
  return url.startsWith('/v1/cx/')
    || url === '/v1/feedback/schema' || url.startsWith('/v1/feedback/schema/')
    || url === '/v1/uploads/screenshot-auth' || url === '/v1/uploads/screenshot-url';
}

/**
 * What the beta key may call: its own routes and the form schema. It ships inside the released app,
 * so it gets no general screenshot credentials; /v1/beta/uploads/screenshot-auth and …/screenshot-url check the user first.
 */
function betaKeyMayCall(url: string): boolean {
  return url.startsWith('/v1/beta/') || url === '/v1/feedback/schema' || url.startsWith('/v1/feedback/schema/');
}

/** Header the dashboard sends on every fetch. Cross-site forms cannot set it, which blocks CSRF on the cookie session. */
export const DASHBOARD_HEADER = 'x-requested-with';

/** Resolves a signed-in user id into the actor for this request. */
export interface ActorResolver {
  /**
   * The signed-in account as this request's actor, with its password timestamp (rotating a password
   * ends the account's other sessions). Null when the account is gone or disabled. One lookup:
   * it runs before every dashboard request.
   */
  sessionFor(userId: string): Promise<{ actor: Actor; passwordEpoch: number } | null>;
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
 * CX key (x-api-key)    → /v1/cx/**, the form schema and screenshot uploads; nothing else
 * beta key (x-api-key)  → /v1/beta/** and the form schema; nothing else
 * /v1/cx/**             → the CX key or x-admin-key only
 * /v1/beta/**           → the beta key or x-admin-key only
 * /v1/admin/**          → x-admin-key, or a session whose role allows the route
 * everything else /v1   → x-api-key (admin key also accepted)
 */
export function registerAuth(
  app: FastifyInstance,
  keys: { app: string; admin: string; cx?: string; beta?: string; sessionSecret: string; cronSecret?: string; keyLogin?: boolean },
  users?: ActorResolver,
) {
  app.decorateRequest('actor', undefined);

  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(url) || PUBLIC_PAGE.test(url)) return;

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

    // The CX tool's key: it decides that a report is a CX report, so it is kept to its own lane.
    if (!actor && keys.cx && apiKey !== undefined && safeEqual(apiKey, keys.cx)) {
      if (!cxKeyMayCall(url)) throw AppError.forbidden('The CX key can only file and read CX reports');
      req.actor = { id: null, email: null, name: 'CX tool', role: 'cx', via: 'cx_key' };
      return;
    }

    // The released app's key, for beta users. It is in every copy of the app, so it reaches nothing else.
    if (!actor && keys.beta && apiKey !== undefined && safeEqual(apiKey, keys.beta)) {
      if (!betaKeyMayCall(url)) throw AppError.forbidden('The beta key can only check beta users and file their reports');
      req.actor = { id: null, email: null, name: 'Luna app (beta)', role: 'business', via: 'beta_key' };
      return;
    }

    if (!actor && header(req, DASHBOARD_HEADER) === 'dashboard') {
      actor = await sessionActor(req, keys.sessionSecret, keys.keyLogin !== false, users);
    }

    if (actor) req.actor = actor;

    // Only the CX tool files CX reports; the app key or a dashboard session never can.
    if (url.startsWith('/v1/cx/')) {
      if (actor?.via !== 'admin_key') throw AppError.unauthorized('Missing or invalid CX key');
      return;
    }
    if (url.startsWith('/v1/beta/')) {
      if (actor?.via !== 'admin_key') throw AppError.unauthorized('Missing or invalid beta key');
      return;
    }

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
    const found = await users.sessionFor(session.userId);
    if (!found || found.passwordEpoch !== session.passwordEpoch) return undefined;
    return found.actor;
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
