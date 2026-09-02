import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
import { SESSION_COOKIE, readCookie, verifySessionToken } from './dashboardSession.js';

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
export const PUBLIC_PATHS = new Set(['/', '/healthz', '/docs', '/dashboard', '/dashboard/login', '/dashboard/logout', '/dashboard/session']);

/** Header the dashboard sends on every fetch. Cross-site forms cannot set it, which blocks CSRF on the cookie session. */
export const DASHBOARD_HEADER = 'x-requested-with';

/**
 * public paths          → open
 * dashboard session     → cookie + x-requested-with header; treated as admin (same-origin only)
 * /v1/admin/**          → x-admin-key
 * everything else /v1   → x-api-key (admin key also accepted)
 */
export function registerAuth(app: FastifyInstance, keys: { app: string; admin: string; sessionSecret: string; cronSecret?: string }) {
  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(url)) return;

    const apiKey = header(req, 'x-api-key');
    const adminKey = header(req, 'x-admin-key');
    let isAdmin = adminKey !== undefined && safeEqual(adminKey, keys.admin);

    // Vercel cron calls GET /v1/admin/diagnoses/run-pending with "Authorization: Bearer <CRON_SECRET>".
    if (!isAdmin && keys.cronSecret && url === '/v1/admin/diagnoses/run-pending') {
      const auth = header(req, 'authorization');
      if (auth && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), keys.cronSecret)) isAdmin = true;
    }

    if (!isAdmin && header(req, DASHBOARD_HEADER) === 'dashboard') {
      const token = readCookie(header(req, 'cookie'), SESSION_COOKIE);
      if (token && verifySessionToken(keys.sessionSecret, token) !== null) isAdmin = true;
    }

    if (url.startsWith('/v1/admin/')) {
      if (!isAdmin) throw AppError.unauthorized('Missing or invalid x-admin-key');
      return;
    }
    if (isAdmin) return;
    if (apiKey === undefined || !safeEqual(apiKey, keys.app)) throw AppError.unauthorized('Missing or invalid x-api-key');
  });
}
