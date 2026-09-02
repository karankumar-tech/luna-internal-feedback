import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { buildFeatureSchema, buildSchemaResponse, etagFor } from '../../schema/buildSchemaResponse.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { PLATFORMS } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import type { FeedbackService } from './feedback.service.js';

const IsTest = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

const AiStatus = z.enum(['none', 'pending', 'running', 'waiting_logs', 'done', 'no_logs', 'failed']).optional();
const AiSide = z.enum(['firmware', 'sdk', 'app', 'backend', 'user_expectation', 'not_a_bug', 'insufficient_logs']).optional();
const AiSeverity = z.enum(['low', 'medium', 'high', 'critical']).optional();

const ListQuery = z.object({
  feature: z.string().optional(),
  platform: z.enum(PLATFORMS).optional(),
  is_test: IsTest,
  ai_status: AiStatus, ai_side: AiSide, ai_severity: AiSeverity,
  user_id: z.coerce.number().int().positive().optional(),
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  is_positive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^[^|]+\|[0-9a-f-]{36}$/, 'invalid cursor').optional(),
});

const StatsQuery = z.object({
  feature: z.string().optional(),
  platform: z.enum(PLATFORMS).optional(),
  is_test: IsTest,
  ai_status: AiStatus, ai_side: AiSide, ai_severity: AiSeverity,
  user_id: z.coerce.number().int().positive().optional(),
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  is_positive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  category: z.string().optional(),
});

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: { service: FeedbackService; categories: CategoriesRepo; timeZone: string },
) {
  const { service, categories, timeZone } = deps;

  // ---- aggregates for the dashboard -----------------------------------------
  app.get('/v1/feedback/stats', async (req) => {
    const parsed = StatsQuery.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const q = parsed.data;
    const to = q.to ?? todayInZone(timeZone);
    const from = q.from ?? shiftDate(to, -29);
    if (from > to) throw AppError.validation([{ path: 'from', message: 'must not be after to' }], 'Invalid query');
    return service.stats({ ...q, from, to });
  });

  // ---- schema for form building -------------------------------------------
  app.get('/v1/feedback/schema', async (req, reply) => {
    const [features, options] = await Promise.all([categories.allFeatures(), categories.activeOptionsByFeature()]);
    const payload = buildSchemaResponse(features, options);
    const etag = etagFor(payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.header('ETag', etag).header('Cache-Control', 'no-cache').send(payload);
  });

  app.get<{ Params: { feature: string } }>('/v1/feedback/schema/:feature', async (req, reply) => {
    const feature = await categories.feature(req.params.feature);
    if (!feature || !feature.is_active) throw AppError.notFound(`Unknown feature "${req.params.feature}"`);
    const options = await categories.activeOptionsByFeature();
    const payload = buildFeatureSchema(feature, options.get(feature.key) ?? []);
    const etag = etagFor(payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.header('ETag', etag).header('Cache-Control', 'no-cache').send(payload);
  });

  // ---- submit ----------------------------------------------------------------
  app.post<{ Params: { feature: string } }>('/v1/feedback/:feature', async (req, reply) => {
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = typeof rawKey === 'string' && rawKey.trim().length > 0 ? rawKey.trim().slice(0, 200) : null;
    const { dto, created } = await service.submit(req.params.feature, req.body, idempotencyKey, req.log);
    return reply.code(created ? 201 : 200).send(dto);
  });

  // ---- read ------------------------------------------------------------------
  app.get('/v1/feedback', async (req) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    return service.list(parsed.data);
  });

  app.get<{ Params: { id: string } }>('/v1/feedback/:id', async (req) => service.get(req.params.id));

  // ---- test data housekeeping (admin) ----------------------------------------
  app.get('/v1/admin/test-data', async () => ({ count: await service.countTestData() }));

  /** Deletes only rows flagged is_test. Requires `?confirm=delete` so a stray call cannot wipe anything. */
  app.delete('/v1/admin/test-data', async (req) => {
    const q = req.query as { confirm?: string };
    if (q.confirm !== 'delete') throw AppError.validation([{ path: 'confirm', message: 'pass ?confirm=delete to delete all test submissions' }]);
    return { deleted: await service.deleteTestData() };
  });
}
