import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function header(req: { headers: Record<string, unknown> }, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * /healthz             → open
 * /v1/admin/**         → x-admin-key
 * everything else /v1  → x-api-key (admin key also accepted)
 */
export function registerAuth(app: FastifyInstance, keys: { app: string; admin: string }) {
  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0] ?? '';
    if (url === '/healthz') return;

    const apiKey = header(req, 'x-api-key');
    const adminKey = header(req, 'x-admin-key');
    const isAdmin = adminKey !== undefined && safeEqual(adminKey, keys.admin);

    if (url.startsWith('/v1/admin/')) {
      if (!isAdmin) throw AppError.unauthorized('Missing or invalid x-admin-key');
      return;
    }
    if (isAdmin) return;
    if (apiKey === undefined || !safeEqual(apiKey, keys.app)) throw AppError.unauthorized('Missing or invalid x-api-key');
  });
}
