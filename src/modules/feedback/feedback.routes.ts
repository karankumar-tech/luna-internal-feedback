import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { buildFeatureSchema, buildSchemaResponse, etagFor } from '../../schema/buildSchemaResponse.js';
import { screenshotSchema, zodIssues } from '../../schema/buildValidator.js';
import { isValidCalendarDate, todayInZone } from '../../lib/time.js';
import { ENVIRONMENTS, ORIGINS, PLATFORMS } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import { PRIORITIES, SUBMISSION_STATUSES, TERMINAL_STATUSES, parseSubmissionRef } from './feedback.repo.js';
import { can, isTeamAction } from '../../lib/actor.js';
import { parseSprintRef } from '../sprints/cycle.js';
import type { FastifyRequest } from 'fastify';
import type { FeedbackService } from './feedback.service.js';

const IsTest = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

/** none (the main list) · any · current · next · a reference like SPR-202610-01. */
export const SprintFilter = z.string().trim().max(20).transform((v, ctx) => {
  const k = v.toLowerCase();
  if (k === 'none' || k === 'any' || k === 'current' || k === 'next') return k;
  const ref = parseSprintRef(v);
  if (!ref) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be none, any, current, next or a sprint like SPR-202610-01' }); return z.NEVER; }
  return ref;
});

const AiStatus = z.enum(['none', 'pending', 'running', 'waiting_logs', 'done', 'no_logs', 'failed']).optional();
const AiSide = z.enum(['firmware', 'sdk', 'app', 'backend', 'user_expectation', 'not_a_bug', 'insufficient_logs']).optional();
const AiSeverity = z.enum(['low', 'medium', 'high', 'critical']).optional();

/** Filters shared by the list, stats and analytics endpoints. */
export const CommonQuery = z.object({
  feature: z.string().optional(),
  environment: z.enum(ENVIRONMENTS).optional(),
  origin: z.enum(ORIGINS).optional(),
  platform: z.enum(PLATFORMS).optional(),
  /** The app version the report was sent from, as the app gives it (2.4.0). */
  app_version: z.string().trim().min(1).max(40).optional(),
  is_test: IsTest,
  status: z.enum(SUBMISSION_STATUSES).optional(),
  jira: z.enum(['any', 'none']).optional(),
  ai_status: AiStatus, ai_side: AiSide, ai_severity: AiSeverity,
  ai_tag: z.string().max(60).optional(),
  /** A tag, several comma-separated (reports with any of them), or 'none' for untagged. */
  tag: z.string().trim().toLowerCase().max(200).optional(),
  /** 'any': a go-live date is planned; 'none': it is not. */
  go_live: z.enum(['any', 'none']).optional(),
  /** Go-live date within this range, inclusive. */
  go_live_from: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  go_live_to: z.string().refine(isValidCalendarDate, 'must be YYYY-MM-DD').optional(),
  /** Which sprint: none (the main list), any, current, next, or a reference. Unset = everything (the Reports list defaults to none). */
  sprint: SprintFilter.optional(),
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

/** A developer may not reopen what QC resolved, closed or won't fix by marking it fixed. */
export async function assertNotFinished(service: FeedbackService, id: string) {
  const row = await service.row(id);
  if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
    throw AppError.conflict(`${row.ref} is already ${row.status.replace('_', ' ')}; only QC can change it now`);
  }
}

/** Tells the app the issue form may carry `sprint`, and where to get the labels for its two choices. */
export const SPRINTS_DESCRIPTOR = {
  field: 'sprint', values: ['current', 'next'], options_endpoint: '/v1/sprints/options',
  note: 'Optional on issues (is_positive: false): "current" files into the current sprint, "next" into the next one. Leave it out for the main issue list. Refused on positive feedback.',
} as const;

export function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: {
    service: FeedbackService; categories: CategoriesRepo; timeZone: string; uploads: ScreenshotUploads | null;
    /** The problems each listed report is confirmed as part of, so the list can show them. */
    kindsFor?: (ids: string[]) => Promise<Map<string, { id: string; ref: string; title: string }[]>>;
    /** Whether an email belongs to an enabled dashboard account, for assigning. */
    isAssignable?: (email: string) => Promise<boolean>;
    /** Display names of dashboard accounts by (lowercased) email, so lists can name a tester rather than number them. */
    testerNames?: (emails: string[]) => Promise<Map<string, string>>;
  },
) {
  const { service, categories, timeZone, uploads, kindsFor, isAssignable, testerNames } = deps;
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
    const payload = { ...buildSchemaResponse(features, options), uploads: uploadsDescriptor(), sprints: SPRINTS_DESCRIPTOR };
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
    // The same contract serves the app and the dashboard's Report page; a signed-in person is recorded as the reporter.
    const source = req.actor?.via === 'session' ? { via: 'dashboard' as const, by: actorOf(req) } : undefined;
    const { dto, created } = await service.submit(req.params.feature, req.body, idempotencyKey, req.log, source);
    return reply.code(created ? 201 : 200).send(dto);
  });

  // ---- read ------------------------------------------------------------------
  app.get('/v1/feedback', async (req) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error), 'Invalid query');
    const { ref, ...filters } = resolveMe(parsed.data, req);
    const page = await service.list({ ...filters, ref_no: ref });
    if (!kindsFor && !testerNames) return page;
    const [kinds, names] = await Promise.all([
      kindsFor ? kindsFor(page.items.map((i) => i.id)) : null,
      testerNames ? testerNames(page.items.map((i) => i.email).filter((e): e is string => !!e)) : null,
    ]);
    return {
      ...page,
      items: page.items.map((i) => ({
        ...i,
        ...(kinds ? { kinds: kinds.get(i.id) ?? [] } : {}),
        ...(names ? { tester_name: (i.email && names.get(i.email.toLowerCase())) ?? null } : {}),
      })),
    };
  });

  /** By uuid or by reference (LN-00042, ln-42, 42). */
  app.get<{ Params: { id: string } }>('/v1/feedback/:id', async (req) => service.get(req.params.id));

  // ---- triage: status, owner, priority, test flag (QC); developers may only mark a bug fixed ----
  app.patch<{ Params: { id: string } }>('/v1/admin/submissions/:id', { onRequest: requirePermission('mark_fixed') }, async (req) => {
    const parsed = z.object({
      is_test: z.boolean().optional(),
      status: z.enum(SUBMISSION_STATUSES).optional(),
      status_note: z.string().trim().max(500).nullish(),
      /** Any dashboard user's email; null unassigns. */
      assigned_to: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
      priority: z.enum(PRIORITIES).nullable().optional(),
      /** "current", "next" or a sprint reference; null puts it back on the main list. */
      sprint: z.string().trim().max(20).nullable().optional(),
      /** Where the issue lives (ios, android, backend, firmware); null clears it. */
      platform: z.enum(PLATFORMS).nullable().optional(),
    }).strict().refine((b) => Object.values(b).some((v) => v !== undefined), {
      message: 'send is_test, status, assigned_to, priority, sprint or platform',
    }).safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const { is_test, status, status_note, assigned_to, priority, sprint, platform } = parsed.data;
    const by = actorOf(req);
    if (!can(req.actor, 'manage_triage')) {
      // Developers: "fixed" and nothing else, and only on a report QC has not finished with.
      const onlyFixed = status === 'fixed' && is_test === undefined && assigned_to === undefined && priority === undefined && sprint === undefined && platform === undefined;
      if (!onlyFixed) throw AppError.forbidden(`Your role (${req.actor?.role ?? 'unknown'}) can only mark a bug as fixed; QC resolves or closes it`);
      await assertNotFinished(service, req.params.id);
    }
    if (sprint !== undefined && !can(req.actor, 'manage_sprints')) throw AppError.forbidden(`Your role (${req.actor?.role ?? 'unknown'}) cannot move reports between sprints`);

    if (assigned_to && isAssignable && !(await isAssignable(assigned_to))) {
      throw AppError.validation([{ path: 'assigned_to', message: `${assigned_to} has no dashboard account` }]);
    }
    let dto = is_test === undefined ? null : await service.setTestFlag(req.params.id, is_test, by);
    if (assigned_to !== undefined) dto = await service.assign(req.params.id, assigned_to, by);
    if (priority !== undefined) dto = await service.setPriority(req.params.id, priority, by);
    if (platform !== undefined) dto = await service.setPlatform(req.params.id, platform, by);
    if (status !== undefined) dto = await service.setStatus(req.params.id, status, status_note ?? null, by, isTeamAction(req));
    // After the status: an explicit sprint wins over the move a reopen makes.
    if (sprint !== undefined) dto = await service.moveToSprint(req.params.id, sprint, by);
    return dto ?? service.get(req.params.id);
  });

  // ---- tags (QC, developers) ----
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/tags', { onRequest: requirePermission('tag_reports') }, async (req) => {
    const parsed = z.object({ add: z.array(z.string().max(40)).max(10).optional(), remove: z.array(z.string().max(40)).max(10).optional() }).strict()
      .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, { message: 'send add or remove' })
      .safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.changeTags(req.params.id, parsed.data, actorOf(req));
  });

  // ---- go-live date (QC, developers) ----
  app.patch<{ Params: { id: string } }>('/v1/admin/submissions/:id/go-live', { onRequest: requirePermission('set_go_live') }, async (req) => {
    const parsed = z.object({
      /** YYYY-MM-DD, or null to clear. Any real date: a past one records when it went live. */
      go_live_on: z.string().refine(isValidCalendarDate, 'must be a real date in YYYY-MM-DD format').nullable(),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.setGoLive(req.params.id, parsed.data.go_live_on, actorOf(req));
  });

  // ---- screenshots added after filing (QC, developers, CX); uploaded first via /v1/uploads/screenshot-auth ----
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/screenshots', { onRequest: requirePermission('add_screenshots') }, async (req, reply) => {
    const parsed = z.object({
      // URLs are checked by the service, so a server without uploads says so rather than "not an ImageKit URL".
      screenshots: z.array(screenshotSchema(() => true)).min(1).max(uploads?.maxCount ?? 5, `at most ${uploads?.maxCount ?? 5} screenshots`),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return reply.code(201).send(await service.addScreenshots(req.params.id, parsed.data.screenshots, actorOf(req)));
  });

  /** Removes a screenshot added on the dashboard: by whoever added it, or QC. The reporter's own stay. */
  app.delete<{ Params: { id: string; fileId: string } }>('/v1/admin/submissions/:id/screenshots/:fileId', { onRequest: requirePermission('add_screenshots') }, async (req) =>
    service.removeScreenshot(req.params.id, req.params.fileId, actorOf(req), can(req.actor, 'manage_triage')));

  /** Tags to offer: those in use (most used first) and the common ones. */
  app.get('/v1/admin/tags', async () => ({ items: await service.knownTags() }));

  // ---- test data housekeeping (admin) ----------------------------------------
  app.get('/v1/admin/test-data', async () => ({ count: await service.countTestData() }));

  /** Deletes only rows flagged is_test. Requires `?confirm=delete` so a stray call cannot wipe anything. */
  app.delete('/v1/admin/test-data', { onRequest: requirePermission('delete_test_data') }, async (req) => {
    const q = req.query as { confirm?: string };
    if (q.confirm !== 'delete') throw AppError.validation([{ path: 'confirm', message: 'pass ?confirm=delete to delete all test submissions' }]);
    return { deleted: await service.deleteTestData() };
  });
}
