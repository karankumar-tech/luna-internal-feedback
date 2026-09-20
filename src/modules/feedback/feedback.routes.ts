import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { buildFeatureSchema, buildSchemaResponse, etagFor } from '../../schema/buildSchemaResponse.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { ENVIRONMENTS, PLATFORMS } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import { SUBMISSION_STATUSES } from './feedback.repo.js';
import type { FeedbackService } from './feedback.service.js';

const IsTest = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

const AiStatus = z.enum(['none', 'pending', 'running', 'waiting_logs', 'done', 'no_logs', 'failed']).optional();
const AiSide = z.enum(['firmware', 'sdk', 'app', 'backend', 'user_expectation', 'not_a_bug', 'insufficient_logs']).optional();
const AiSeverity = z.enum(['low', 'medium', 'high', 'critical']).optional();

/** Filters shared by the list, stats and analytics endpoints. */
export const CommonQuery = z.object({
  feature: z.string().optional(),
  environment: z.enum(ENVIRONMENTS).optional(),
  platform: z.enum(PLATFORMS).optional(),
  is_test: IsTest,
  status: z.enum(SUBMISSION_STATUSES).optional(),
  jira: z.enum(['any', 'none']).optional(),
  ai_status: AiStatus, ai_side: AiSide, ai_severity: AiSeverity,
  ai_tag: z.string().max(60).optional(),
  event_code: z.string().max(20).optional(),
  kind_id: z.string().uuid().optional(),
  user_id: z.coerce.number().int().positive().optional(),
  is_positive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  category: z.string().optional(),
});

const DateRange = {
  from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
};

const ListQuery = CommonQuery.extend({
  ...DateRange,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^[^|]+\|[0-9a-f-]{36}$/, 'invalid cursor').optional(),
});

const StatsQuery = CommonQuery.extend(DateRange);

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ScreenshotUploads {
  publicKey: string;
  urlEndpoint: string;
  folder: string;
  maxBytes: number;
  maxCount: number;
  authParams: () => { token: string; expire: number; signature: string };
}

export const SCREENSHOT_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'] as const;
/** Applied by ImageKit before storing: longest side 1600 px, JPEG quality 80. Keeps storage and delivery small even if the app skips resizing. */
export const SCREENSHOT_PRE_TRANSFORMATION = 'w-1600,h-1600,c-at_max,q-80';
/** What the app should do before uploading so uploads are fast on mobile networks. */
export const SCREENSHOT_CLIENT_RESIZE = { max_dimension: 1600, jpeg_quality: 0.8, target_bytes: 500 * 1024, note: 'Downscale so the longest side is ≤ 1600 px and encode as JPEG (quality ~0.8) before uploading. Convert HEIC/camera photos to JPEG on device. Typical result: 150–500 KB.' } as const;

export function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: { service: FeedbackService; categories: CategoriesRepo; timeZone: string; uploads: ScreenshotUploads | null },
) {
  const { service, categories, timeZone, uploads } = deps;
  const uploadsDescriptor = () => ({
    screenshots: uploads
      ? { enabled: true, auth_endpoint: '/v1/uploads/screenshot-auth', upload_url: 'https://upload.imagekit.io/api/v1/files/upload', max_count: uploads.maxCount, max_bytes: uploads.maxBytes, accepted_types: [...SCREENSHOT_TYPES], url_endpoint: uploads.urlEndpoint, client_resize: SCREENSHOT_CLIENT_RESIZE }
      : { enabled: false },
  });

  // ---- short-lived ImageKit upload credentials (app uploads directly to ImageKit) ----
  app.get('/v1/uploads/screenshot-auth', async () => {
    if (!uploads) throw AppError.validation([{ path: 'screenshots', message: 'screenshot uploads are not configured on the server' }], 'Uploads unavailable');
    const a = uploads.authParams();
    return {
      upload_url: 'https://upload.imagekit.io/api/v1/files/upload',
      public_key: uploads.publicKey,
      token: a.token, expire: a.expire, signature: a.signature,
      folder: uploads.folder, use_unique_file_name: true, tags: ['luna-feedback'],
      /** Send verbatim as the `transformation` form field (JSON string). ImageKit resizes before storing. */
      transformation: { pre: SCREENSHOT_PRE_TRANSFORMATION },
      max_bytes: uploads.maxBytes, max_count: uploads.maxCount, accepted_types: [...SCREENSHOT_TYPES],
      client_resize: SCREENSHOT_CLIENT_RESIZE,
      url_endpoint: uploads.urlEndpoint,
    };
  });

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
    const payload = { ...buildSchemaResponse(features, options), uploads: uploadsDescriptor() };
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

  // ---- mark one submission as test / real, or move it through triage (admin) ----
  app.patch<{ Params: { id: string } }>('/v1/admin/submissions/:id', async (req) => {
    const parsed = z.object({
      is_test: z.boolean().optional(),
      status: z.enum(SUBMISSION_STATUSES).optional(),
      status_note: z.string().trim().max(500).nullish(),
    }).strict().refine((b) => b.is_test !== undefined || b.status !== undefined, {
      message: 'send is_test, status, or both',
    }).safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const { is_test, status, status_note } = parsed.data;

    let dto = is_test === undefined ? null : await service.setTestFlag(req.params.id, is_test);
    if (status !== undefined) dto = await service.setStatus(req.params.id, status, status_note ?? null, actorOf(req));
    return dto ?? service.get(req.params.id);
  });

  // ---- test data housekeeping (admin) ----------------------------------------
  app.get('/v1/admin/test-data', async () => ({ count: await service.countTestData() }));

  /** Deletes only rows flagged is_test. Requires `?confirm=delete` so a stray call cannot wipe anything. */
  app.delete('/v1/admin/test-data', async (req) => {
    const q = req.query as { confirm?: string };
    if (q.confirm !== 'delete') throw AppError.validation([{ path: 'confirm', message: 'pass ?confirm=delete to delete all test submissions' }]);
    return { deleted: await service.deleteTestData() };
  });
}
