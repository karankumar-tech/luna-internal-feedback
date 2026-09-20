import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { JiraService } from './jira.service.js';

export function registerJiraRoutes(app: FastifyInstance, deps: { service: JiraService }) {
  const { service } = deps;

  /** Read by the dashboard on load so the Jira buttons can be shown, hidden or explained. */
  app.get('/v1/admin/jira/status', async () => service.status());

  /** Verifies the credentials and project without creating anything. */
  app.post('/v1/admin/jira/check', async () => service.check());

  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/jira', async (req, reply) => {
    const { issue, created } = await service.createForSubmission(req.params.id, actorOf(req));
    return reply.code(created ? 201 : 200).send({ ...issue, created });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/jira/refresh', async (req) =>
    service.refreshSubmission(req.params.id));

  app.post<{ Params: { id: string } }>('/v1/admin/kinds/:id/jira', async (req, reply) => {
    const { issue, created } = await service.createForKind(req.params.id, actorOf(req));
    return reply.code(created ? 201 : 200).send({ ...issue, created });
  });

  /** Nightly refresh of cached workflow statuses; also callable by hand. */
  app.post('/v1/admin/jira/refresh-stale', async (req) => {
    const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      older_than_minutes: z.coerce.number().int().min(1).max(10_080).default(60),
    }).safeParse(req.query ?? {});
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    return service.refreshStale(parsed.data.limit, parsed.data.older_than_minutes);
  });
}
