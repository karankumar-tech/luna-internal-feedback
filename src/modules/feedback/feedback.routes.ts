import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { buildFeatureSchema, buildSchemaResponse, etagFor } from '../../schema/buildSchemaResponse.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { ENVIRONMENTS, ORIGINS, PLATFORMS } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import { PRIORITIES, SUBMISSION_STATUSES, parseSubmissionRef } from './feedback.repo.js';
import { isTeamAction } from '../../lib/actor.js';
import type { FastifyRequest } from 'fastify';
import type { FeedbackService } from './feedback.service.js';

const IsTest = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

const AiStatus = z.enum(['none', 'pending', 'running', 'waiting_logs', 'done', 'no_logs', 'failed']).optional();
const AiSide = z.enum(['firmware', 'sdk', 'app', 'backend', 'user_expectation', 'not_a_bug', 'insufficient_logs']).optional();
const AiSeverity = z.enum(['low', 'medium', 'high', 'critical']).optional();

/** Filters shared by the list, stats and analytics endpoints. */
export const CommonQuery = z.object({
  feature: z.string().optional(),
  environment: z.enum(ENVIRONMENTS).optional(),
  origin: z.enum(ORIGINS).optional(),
  platform: z.enum(PLATFORMS).optional(),
  is_test: IsTest,
  status: z.enum(SUBMISSION_STATUSES).optional(),
  jira: z.enum(['any', 'none']).optional(),
  ai_status: AiStatus, ai_side: AiSide, ai_severity: AiSeverity,
  ai_tag: z.string().max(60).optional(),
  event_code: z.string().max(20).optional(),
  kind_id: z.string().uuid().optional(),
  /** An owner's email, 'me' for the signed-in person, or 'none' for unassigned. */
  assigned_to: z.string().trim().toLowerCase().max(254).optional(),
  priority: z.enum([...PRIORITIES, 'none']).optional(),
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
  /** One report by reference: LN-00042, ln-42 or 42. */
  ref: z.string().trim().max(20).transform((v, ctx) => {
    const n = parseSubmissionRef(v);
    if (n === null) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must look like LN-00042' }); return z.NEVER; }
    return n;
  }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^[^|]+\|[0-9a-f-]{36}$/, 'invalid cursor').optional(),
});

const StatsQuery = CommonQuery.extend(DateRange);

/** "assigned_to=me" becomes the signed-in person's email (or nobody's, for a key without one). */
export function resolveMe<T extends { assigned_to?: string }>(q: T, req: FastifyRequest): T {
  if (q.assigned_to !== 'me') return q;
  return { ...q, assigned_to: req.actor?.email ?? 'nobody@invalid' };
}

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
  deps: {
    service: FeedbackService; categories: CategoriesRepo; timeZone: string; uploads: ScreenshotUploads | null;
    /** The problems each listed report is confirmed as part of, so the list can show them. */
    kindsFor?: (ids: string[]) => Promise<Map<string, { id: string; ref: string; title: string }[]>>;
    /** Whether an email belongs to an enabled dashboard account, for assigning. */
    isAssignable?: (email: string) => Promise<boolean>;
  },
) {
  const { service, categories, timeZone, uploads, kindsFor, isAssignable } = deps;
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
    return service.stats(resolveMe({ ...q, from, to }, req));
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
    const { ref, ...filters } = resolveMe(parsed.data, req);
    const page = await service.list({ ...filters, ref_no: ref });
    if (!kindsFor) return page;
    const kinds = await kindsFor(page.items.map((i) => i.id));
    return { ...page, items: page.items.map((i) => ({ ...i, kinds: kinds.get(i.id) ?? [] })) };
  });

  /** By uuid or by reference (LN-00042, ln-42, 42). */
  app.get<{ Params: { id: string } }>('/v1/feedback/:id', async (req) => service.get(req.params.id));

  // ---- triage: status, owner, priority, test flag (QC) ----
  app.patch<{ Params: { id: string } }>('/v1/admin/submissions/:id', { onRequest: requirePermission('manage_triage') }, async (req) => {
    const parsed = z.object({
      is_test: z.boolean().optional(),
      status: z.enum(SUBMISSION_STATUSES).optional(),
      status_note: z.string().trim().max(500).nullish(),
      /** Any dashboard user's email; null unassigns. */
      assigned_to: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
      priority: z.enum(PRIORITIES).nullable().optional(),
    }).strict().refine((b) => Object.values(b).some((v) => v !== undefined), {
      message: 'send is_test, status, assigned_to or priority',
    }).safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const { is_test, status, status_note, assigned_to, priority } = parsed.data;
    const by = actorOf(req);

    if (assigned_to && isAssignable && !(await isAssignable(assigned_to))) {
      throw AppError.validation([{ path: 'assigned_to', message: `${assigned_to} has no dashboard account` }]);
    }
    let dto = is_test === undefined ? null : await service.setTestFlag(req.params.id, is_test, by);
    if (assigned_to !== undefined) dto = await service.assign(req.params.id, assigned_to, by);
    if (priority !== undefined) dto = await service.setPriority(req.params.id, priority, by);
    if (status !== undefined) dto = await service.setStatus(req.params.id, status, status_note ?? null, by, isTeamAction(req));
    return dto ?? service.get(req.params.id);
  });

  // ---- test data housekeeping (admin) ----------------------------------------
  app.get('/v1/admin/test-data', async () => ({ count: await service.countTestData() }));

  /** Deletes only rows flagged is_test. Requires `?confirm=delete` so a stray call cannot wipe anything. */
  app.delete('/v1/admin/test-data', { onRequest: requirePermission('delete_test_data') }, async (req) => {
    const q = req.query as { confirm?: string };
    if (q.confirm !== 'delete') throw AppError.validation([{ path: 'confirm', message: 'pass ?confirm=delete to delete all test submissions' }]);
    return { deleted: await service.deleteTestData() };
  });
}
