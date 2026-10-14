import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { isValidCalendarDate } from '../../lib/time.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { SprintsService } from './sprints.service.js';

const Day = z.string().refine(isValidCalendarDate, 'must be a real date in YYYY-MM-DD format');

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw AppError.validation(zodIssues(r.error));
  return r.data;
}

/**
 * Sprints: half-month cycles QA files issues against (docs/PLAN-sprints.md).
 *   GET  /v1/sprints                     every sprint with its counts (any signed-in role, the app key too)
 *   GET  /v1/sprints/options             the app's two choices: current and next
 *   GET  /v1/sprints/:ref                one sprint (a reference, "current" or "next")
 *   POST/PATCH/close/DELETE under /v1/admin/sprints   QC and admins; deleting is admins only
 */
export function registerSprintRoutes(app: FastifyInstance, deps: { service: SprintsService }) {
  const { service } = deps;

  app.get('/v1/sprints', async () => service.list());
  app.get('/v1/sprints/options', async () => service.options());
  app.get<{ Params: { ref: string } }>('/v1/sprints/:ref', async (req) => service.get(req.params.ref, req.actor?.email ?? null));

  app.post('/v1/admin/sprints', { onRequest: requirePermission('manage_sprints') }, async (req, reply) => {
    const body = parse(z.object({
      starts_on: Day.optional(),
      ends_on: Day.optional(),
      name: z.string().trim().min(1).max(80).optional(),
      goal: z.string().trim().max(300).nullable().optional(),
    }).strict(), req.body ?? {});
    return reply.code(201).send(await service.create(body, actorOf(req)));
  });

  app.patch<{ Params: { ref: string } }>('/v1/admin/sprints/:ref', { onRequest: requirePermission('manage_sprints') }, async (req) => {
    const body = parse(z.object({
      starts_on: Day.optional(),
      ends_on: Day.optional(),
      name: z.string().trim().min(1).max(80).optional(),
      goal: z.string().trim().max(300).nullable().optional(),
    }).strict().refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'send name, goal, starts_on or ends_on' }), req.body);
    return service.update(req.params.ref, body);
  });

  app.post<{ Params: { ref: string } }>('/v1/admin/sprints/:ref/close', { onRequest: requirePermission('manage_sprints') }, async (req) => {
    const body = parse(z.object({
      /** Where the open issues go unless overridden: the next sprint (default) or the main list. */
      default: z.enum(['next', 'main']).default('next'),
      /** Per issue (a uuid or LN-00042): "next", "main" or a planned sprint's reference. */
      overrides: z.record(z.string().max(60), z.string().trim().max(20)).optional(),
    }).strict(), req.body ?? {});
    const out = await service.close(req.params.ref, body, actorOf(req));
    req.log.info({ sprint: out.closed, current: out.current, moved: out.moved.length, by: actorOf(req) }, 'sprint closed');
    return out;
  });

  /** Deletes a finished sprint and its issues for good. `?confirm=<ref>` must repeat the reference. */
  app.delete<{ Params: { ref: string }; Querystring: { confirm?: string } }>('/v1/admin/sprints/:ref', { onRequest: requirePermission('delete_sprints') }, async (req) => {
    const out = await service.remove(req.params.ref, req.query.confirm);
    req.log.warn({ sprint: out.ref, deleted_issues: out.deleted_issues, by: actorOf(req) }, 'sprint deleted with its issues');
    return out;
  });
}
