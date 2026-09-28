import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { CommonQuery } from '../feedback/feedback.routes.js';
import { KIND_STATUSES } from './kinds.repo.js';
import type { KindsService } from './kinds.service.js';
import type { FeedbackService } from '../feedback/feedback.service.js';

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

const PatchBody = KindBody.partial().extend({
  is_archived: z.boolean().optional(),
  /** The report to read first: an id or a reference (LN-00042); null clears it. */
  reference_submission_id: z.string().trim().max(60).nullable().optional(),
}).strict();

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function registerKindRoutes(app: FastifyInstance, deps: { service: KindsService; feedback: FeedbackService; timeZone: string }) {
  const { service, feedback, timeZone } = deps;

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

  app.post('/v1/admin/kinds', { onRequest: requirePermission('manage_kinds') }, async (req, reply) => {
    const parsed = KindBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const kind = await service.create(parsed.data, actorOf(req));
    return reply.code(201).send(kind);
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/kinds/:id', { onRequest: requirePermission('manage_kinds') }, async (req) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const { key: _keyIsImmutable, reference_submission_id: reference, ...patch } = parsed.data;
    return service.update(req.params.id, {
      ...patch,
      description: patch.description ?? undefined,
      feature_key: patch.feature_key ?? undefined,
      severity: patch.severity ?? undefined,
      reference_submission_id: reference === undefined ? undefined : reference === null ? null : (await feedback.row(reference)).id,
    });
  });

  // ---- linking tickets to kinds ----------------------------------------------
  /** A report's problems (confirmed and suggested), each with how big it is overall. */
  app.get<{ Params: { id: string } }>('/v1/feedback/:id/kinds', async (req) => {
    const sub = await feedback.row(req.params.id);
    return { items: await service.forSubmissionWithCounts(sub.id, sub.is_test) };
  });

  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/kinds', { onRequest: requirePermission('manage_kinds') }, async (req) => {
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

  /** Unlink = "not this problem", remembered so it is never suggested again. */
  app.delete<{ Params: { id: string; kindId: string } }>('/v1/admin/submissions/:id/kinds/:kindId', { onRequest: requirePermission('manage_kinds') }, async (req) => ({
    items: await service.unlink(req.params.id, req.params.kindId, actorOf(req)),
  }));

  /** CX (or anyone who can see a report) proposes a problem for it; someone who manages kinds decides. */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/kinds/suggest', { onRequest: requirePermission('suggest_kinds') }, async (req) => {
    const parsed = z.object({ kind_id: z.string().trim().min(1).max(60) }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const sub = await feedback.row(req.params.id);
    await service.suggest(sub.id, parsed.data.kind_id, actorOf(req));
    return { items: await service.forSubmissionWithCounts(sub.id, sub.is_test) };
  });

  /** Confirm or reject a suggested (or existing) link. */
  app.post<{ Params: { id: string; kindId: string } }>('/v1/admin/submissions/:id/kinds/:kindId/decision', { onRequest: requirePermission('manage_kinds') }, async (req) => {
    const parsed = z.object({ decision: z.enum(['confirm', 'reject']) }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const sub = await feedback.row(req.params.id);
    await service.decide(sub.id, req.params.kindId, parsed.data.decision, actorOf(req));
    return { items: await service.forSubmissionWithCounts(sub.id, sub.is_test) };
  });

  /** Folds this problem into another; its reports, tags, Jira ticket and title move over. */
  app.post<{ Params: { id: string } }>('/v1/admin/kinds/:id/merge', { onRequest: requirePermission('manage_kinds') }, async (req) => {
    const parsed = z.object({ into: z.string().trim().min(1).max(60) }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.merge(req.params.id, parsed.data.into);
  });
}
