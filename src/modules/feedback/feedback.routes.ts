import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { buildFeatureSchema, buildSchemaResponse, etagFor } from '../../schema/buildSchemaResponse.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { isValidCalendarDate } from '../../lib/time.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import type { FeedbackService } from './feedback.service.js';

const ListQuery = z.object({
  feature: z.string().optional(),
  user_id: z.coerce.number().int().positive().optional(),
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  is_positive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^[^|]+\|[0-9a-f-]{36}$/, 'invalid cursor').optional(),
});

export function registerFeedbackRoutes(app: FastifyInstance, deps: { service: FeedbackService; categories: CategoriesRepo }) {
  const { service, categories } = deps;

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
    const { dto, created } = await service.submit(req.params.feature, req.body, idempotencyKey);
    return reply.code(created ? 201 : 200).send(dto);
  });

  // ---- read ------------------------------------------------------------------
  app.get('/v1/feedback', async (req) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    return service.list(parsed.data);
  });

  app.get<{ Params: { id: string } }>('/v1/feedback/:id', async (req) => service.get(req.params.id));
}
