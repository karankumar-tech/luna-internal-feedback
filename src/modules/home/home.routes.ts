import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { permissionsOf } from '../../lib/actor.js';
import { isValidCalendarDate } from '../../lib/time.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { CommonQuery, resolveMe } from '../feedback/feedback.routes.js';
import { HOME_PAGE_SIZE, type HomeService } from './home.service.js';
import type { HomeListFilters } from './home.repo.js';

/**
 * The home list's own query: the dashboard filters, plus
 *   view      issues (default) · mine (my open issues, as the tab's count) · fine (working fine) · all
 *   data      real (default) · test · all
 *   received  today · 7d: received, rather than happened, in that window (what the top numbers count)
 *   page, page_size
 */
const ReportsQuery = CommonQuery.omit({ is_test: true, is_positive: true }).extend({
  view: z.enum(['issues', 'mine', 'fine', 'all']).default('issues'),
  data: z.enum(['real', 'test', 'all']).default('real'),
  received: z.enum(['today', '7d']).optional(),
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(5).max(100).default(HOME_PAGE_SIZE),
});

export function registerHomeRoutes(app: FastifyInstance, deps: { service: HomeService }) {
  /** Everything the home page shows on arrival, in one request. */
  app.get('/v1/home', async (req) => {
    const actor = req.actor;
    const out = await deps.service.overview(actor?.email ?? null);
    return {
      viewer: actor ? { email: actor.email, name: actor.name, role: actor.role, permissions: permissionsOf(actor) } : null,
      ...out,
    };
  });

  /** One page of the home list, for another page, view or set of filters. */
  app.get('/v1/home/reports', async (req) => {
    const parsed = ReportsQuery.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const { view, data, received, page, page_size, ...rest } = parsed.data;
    if (rest.from && rest.to && rest.from > rest.to) throw AppError.validation([{ path: 'from', message: 'must not be after to' }], 'Invalid query');
    const filters: HomeListFilters = resolveMe({
      ...rest,
      ...(view === 'mine' ? { assigned_to: 'me', openOnly: !rest.status } : {}),
      is_positive: view === 'fine' ? true : view === 'all' ? undefined : false,
      is_test: data === 'all' ? undefined : data === 'test',
      receivedDays: received === 'today' ? 1 : received === '7d' ? 7 : undefined,
    }, req);
    return deps.service.reports(filters, page, page_size);
  });
}
