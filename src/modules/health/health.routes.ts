import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/pool.js';

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Db }) {
  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.db.query('select 1');
      return { ok: true, db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });
}
