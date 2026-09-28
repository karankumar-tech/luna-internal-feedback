import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { CommonQuery, resolveMe } from '../feedback/feedback.routes.js';
import type { AttentionService } from './attention.service.js';

/** The slice the attention page can narrow to. Real data only unless is_test is asked for. */
const AttentionQuery = CommonQuery.pick({ feature: true, environment: true, origin: true, platform: true, is_test: true, assigned_to: true, priority: true });

export function registerAttentionRoutes(app: FastifyInstance, deps: { service: AttentionService }) {
  app.get('/v1/attention', async (req) => {
    const parsed = AttentionQuery.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const filters = resolveMe({ ...parsed.data, is_test: parsed.data.is_test ?? false }, req);
    return deps.service.overview(filters, req.actor?.email ?? null);
  });
}
