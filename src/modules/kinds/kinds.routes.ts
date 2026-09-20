import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { CommonQuery } from '../feedback/feedback.routes.js';
import { KIND_STATUSES } from './kinds.repo.js';
import type { KindsService } from './kinds.service.js';

const ListQuery = CommonQuery.omit({ status: true }).extend({
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  /** The kind's own status, not the submission's. */
  status: z.enum(KIND_STATUSES).optional(),
  include_archived: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const KindBody = z.object({
  title: z.string().trim().min(4).max(120),
  key: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).nullish(),
  feature_key: z.string().trim().max(40).nullish(),
  tags: z.array(z.string().trim().max(60)).max(10).optional(),
  event_codes: z.array(z.string().trim().max(20)).max(10).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullish(),
  status: z.enum(KIND_STATUSES).optional(),
}).strict();

const PatchBody = KindBody.partial().extend({ is_archived: z.boolean().optional() }).strict();

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function registerKindRoutes(app: FastifyInstance, deps: { service: KindsService; timeZone: string }) {
  const { service, timeZone } = deps;

  /** Default window matches the dashboard's: the last 30 days. */
  function parseList(query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const { include_archived, ...rest } = parsed.data;
    const to = rest.to ?? todayInZone(timeZone);
    const from = rest.from ?? shiftDate(to, -29);
    if (from > to) throw AppError.validation([{ path: 'from', message: 'must not be after to' }], 'Invalid query');
    return { ...rest, from, to, includeArchived: include_archived === true };
  }

  app.get('/v1/kinds', async (req) => ({ items: await service.list(parseList(req.query)) }));

  app.get<{ Params: { id: string } }>('/v1/kinds/:id', async (req) => {
    const { includeArchived: _ignored, status: _kindStatus, ...filters } = parseList(req.query);
    return service.detail(req.params.id, filters);
  });

  app.post('/v1/admin/kinds', async (req, reply) => {
    const parsed = KindBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const kind = await service.create(parsed.data, actorOf(req));
    return reply.code(201).send(kind);
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/kinds/:id', async (req) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const { key: _keyIsImmutable, ...patch } = parsed.data;
    return service.update(req.params.id, {
      ...patch,
      description: patch.description ?? undefined,
      feature_key: patch.feature_key ?? undefined,
      severity: patch.severity ?? undefined,
    });
  });

  // ---- linking tickets to kinds ----------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/feedback/:id/kinds', async (req) => ({
    items: await service.forSubmission(req.params.id),
  }));

  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/kinds', async (req) => {
    const parsed = z.object({
      kind_id: z.string().uuid().optional(),
      /** Create-and-link in one step, for "this is a new kind of issue" from the ticket page. */
      title: z.string().trim().min(4).max(120).optional(),
    }).strict().refine((b) => Boolean(b.kind_id) !== Boolean(b.title), { message: 'send either kind_id or title' })
      .safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));

    const by = actorOf(req);
    const kindId = parsed.data.kind_id
      ?? (await service.create({ title: parsed.data.title! }, by)).id;
    return { items: await service.link(req.params.id, kindId, 'manual', null, by) };
  });

  app.delete<{ Params: { id: string; kindId: string } }>('/v1/admin/submissions/:id/kinds/:kindId', async (req) => ({
    items: await service.unlink(req.params.id, req.params.kindId),
  }));
}
