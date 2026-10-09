import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { CommonQuery } from '../feedback/feedback.routes.js';
import { CATALOG } from '../diagnosis/knowledge/catalog.js';
import type { AnalyticsRepo } from './analytics.repo.js';
import type { ModelUsageRepo } from './model-usage.repo.js';

const Query = CommonQuery.extend({
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
});

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AnalyticsRouteDeps {
  repo: AnalyticsRepo;
  timeZone: string;
  usage: ModelUsageRepo;
  /** The models calls go to right now: diagnosis and same-issue matching use `current`, the ticket chat `chat`. */
  models: { current: string; chat: string; enabled: boolean };
}

export function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsRouteDeps) {
  app.get('/v1/analytics/overview', async (req) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const q = parsed.data;
    const to = q.to ?? todayInZone(deps.timeZone);
    const from = q.from ?? shiftDate(to, -29);
    if (from > to) throw AppError.validation([{ path: 'from', message: 'must not be after to' }], 'Invalid query');
    return deps.repo.overview({ ...q, from, to });
  });

  /**
   * Rough token use per day over the last 30 days, by model. Not filtered: it is about the
   * service's spend, not about any slice of reports.
   */
  app.get('/v1/analytics/model-usage', async () => {
    const usage = await deps.usage.lastDays();
    return { ...usage, current_model: deps.models.current, chat_model: deps.models.chat, enabled: deps.models.enabled };
  });

  /** The event catalog itself, for filter dropdowns and the reference table. */
  app.get('/v1/catalog/events', async (req) => {
    const parsed = z.object({
      domain: z.enum(['firmware', 'sdk', 'app']).optional(),
      q: z.string().trim().max(80).optional(),
    }).safeParse(req.query ?? {});
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const { domain, q } = parsed.data;
    const needle = q?.toLowerCase();
    const items = CATALOG.events
      .filter((e) => (!domain || e.domain === domain))
      .filter((e) => !needle || `${e.id} ${e.event} ${e.area ?? ''} ${e.tag ?? ''} ${e.means ?? ''}`.toLowerCase().includes(needle))
      // The excerpt probes are an implementation detail of matching; they are not useful here.
      .map(({ match: _probes, ...rest }) => rest);
    return { version: CATALOG.version, source: CATALOG.generated_from, count: items.length, items };
  });
}
