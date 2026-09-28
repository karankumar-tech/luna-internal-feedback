import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { SimilarService } from './similar.service.js';

const Limit = z.coerce.number().int().min(1).max(50);
/** Report ids or references (LN-00042). */
const ReportIds = z.array(z.string().trim().min(1).max(60)).min(1, 'tick at least one report').max(100);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw AppError.validation(zodIssues(r.error));
  return r.data;
}

export function registerSimilarRoutes(app: FastifyInstance, deps: { service: SimilarService }) {
  const { service } = deps;

  /** Look-alikes of one report, best first, with why each matched. */
  app.get<{ Params: { id: string } }>('/v1/feedback/:id/similar', async (req) => {
    const q = parse(z.object({ limit: Limit.default(20) }), req.query);
    return { ...(await service.similarTo(req.params.id, q.limit)), ai_enabled: service.aiEnabled };
  });

  /** Reports that look like a problem's own and are not linked to it yet ("find more instances"). Omit is_test for real and test alike. */
  app.get<{ Params: { id: string } }>('/v1/kinds/:id/similar', async (req) => {
    const q = parse(z.object({ limit: Limit.default(30), is_test: z.enum(['true', 'false']).optional() }), req.query);
    return service.similarToKind(req.params.id, q.is_test === undefined ? null : q.is_test === 'true', q.limit);
  });

  /** "These are the same issue": the report and the ticked ones go under one problem, new or existing. */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/same', { onRequest: requirePermission('manage_kinds') }, async (req) => {
    const body = parse(z.object({
      submission_ids: ReportIds,
      kind_id: z.string().trim().max(60).optional(),
      title: z.string().trim().min(4).max(120).optional(),
    }).strict(), req.body);
    return service.markSame(req.params.id, body, actorOf(req));
  });

  /** Adds reports to a problem from the problem's page. */
  app.post<{ Params: { id: string } }>('/v1/admin/kinds/:id/reports', { onRequest: requirePermission('manage_kinds') }, async (req) => {
    const body = parse(z.object({ submission_ids: ReportIds }).strict(), req.body);
    return service.addToKind(req.params.id, body.submission_ids, actorOf(req));
  });

  /** Asks the model which of the top look-alikes are really the same issue. Spends a little (about $0.002). */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/similar/ai-check', { onRequest: requirePermission('run_diagnosis') }, async (req) =>
    service.aiCheck(req.params.id, actorOf(req)));
}
