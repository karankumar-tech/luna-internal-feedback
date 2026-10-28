import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/pool.js';

/** `/health` is the probe path on EKS; `/healthz` stays for the existing Vercel deploy and its monitors. */
export const HEALTH_PATHS = ['/health', '/healthz'] as const;

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Db }) {
  for (const path of HEALTH_PATHS) {
    app.get(path, async (_req, reply) => {
      try {
        await deps.db.query('select 1');
        return { ok: true, db: 'up' };
      } catch (err) {
        app.log.error({ err }, 'health check: database unreachable');
        return reply.code(503).send({ ok: false, db: 'down' });
      }
    });
  }
}
