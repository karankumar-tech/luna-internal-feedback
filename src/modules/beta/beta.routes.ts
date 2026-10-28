import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { SCREENSHOT_CLIENT_RESIZE, SCREENSHOT_PRE_TRANSFORMATION, SCREENSHOT_TYPES, type ScreenshotUploads } from '../feedback/feedback.routes.js';
import { screenshotUploadTarget } from '../uploads/uploads.routes.js';
import type { FeedbackService, SubmissionDto } from '../feedback/feedback.service.js';
import type { BetaUserEntry, BetaUsersRepo } from './beta-users.repo.js';

/** How long the app may keep a user's answer before asking again. */
export const BETA_CHECK_CACHE_SECONDS = 24 * 60 * 60;

/** Most ids one Settings request may add or remove: the whole list is expected to stay near this. */
const MAX_IDS_PER_CHANGE = 2000;

const UserId = z.coerce.number({ invalid_type_error: 'must be a Luna user id' }).int('must be a whole number').positive('must be a Luna user id');
/** A label to tell beta users apart on the dashboard. "" or null clears it. */
const Name = z.string().trim().max(120, 'must be at most 120 characters').nullable().transform((v) => v || null);

/**
 * What the app sees of a beta user's report: its reference to show them, and where it stands.
 * Triage details (owners, notes, AI output) stay on the dashboard.
 */
export interface BetaReportView {
  id: string;
  ref: string;
  feature_key: string;
  is_positive: boolean;
  occurred_on: string;
  status: string;
  created_at: string;
  created_at_ist: string;
}

const view = (dto: SubmissionDto): BetaReportView => ({
  id: dto.id, ref: dto.ref, feature_key: dto.feature_key, is_positive: dto.is_positive, occurred_on: dto.occurred_on,
  status: dto.status, created_at: dto.created_at, created_at_ist: dto.created_at_ist,
});

/**
 * Beta users: production customers who may send reports from the released app.
 *
 * The app's lane (BETA_API_KEY): ask whether a user is on the list, then file their reports. The
 * list is held in memory, so the check never waits on the database once it is warm.
 * Settings (QC, admins): add and remove user ids.
 */
export function registerBetaRoutes(
  app: FastifyInstance,
  deps: { beta: BetaUsersRepo; feedback: FeedbackService; uploads: ScreenshotUploads | null },
) {
  const { beta, feedback, uploads } = deps;

  async function requireBeta(userId: number) {
    if (!(await beta.has(userId))) throw new AppError(403, 'NOT_A_BETA_USER', `User ${userId} is not a beta user`);
  }

  /** Whether the app should show this user the feedback option. Ask once a day at most. */
  app.get<{ Params: { userId: string } }>('/v1/beta/users/:userId', async (req, reply) => {
    const parsed = UserId.safeParse(req.params.userId);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error).map((i) => ({ ...i, path: 'user_id' })));
    const isBeta = await beta.has(parsed.data);
    return reply
      .header('Cache-Control', `private, max-age=${BETA_CHECK_CACHE_SECONDS}`)
      .send({ user_id: parsed.data, is_beta: isBeta, cache_seconds: BETA_CHECK_CACHE_SECONDS });
  });

  /**
   * A beta user's report: the same body the app sends for internal testers (POST /v1/feedback/:feature),
   * minus sprint. 201 when stored; 200 when this Idempotency-Key was already used for this user.
   */
  app.post<{ Params: { feature: string } }>('/v1/beta/feedback/:feature', async (req, reply) => {
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = typeof rawKey === 'string' && rawKey.trim().length > 0 ? rawKey.trim().slice(0, 200) : null;
    const { dto, created } = await feedback.submitBeta(req.params.feature, req.body, idempotencyKey, req.log);
    // A replayed key only ever returns this user's own beta report.
    const sentBy = (req.body as { user_id?: unknown } | undefined)?.user_id;
    if (!created && (dto.origin !== 'beta' || dto.user_id !== sentBy)) throw AppError.conflict('This Idempotency-Key was already used for another report');
    return reply.code(created ? 201 : 200).send(view(dto));
  });

  /** Upload credentials for a beta user's screenshots: the same as /v1/uploads/screenshot-auth, for users on the list only. */
  app.get('/v1/beta/uploads/screenshot-auth', async (req) => {
    const parsed = z.object({ user_id: UserId }).safeParse(req.query);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    await requireBeta(parsed.data.user_id);
    const ik = uploads?.imagekit;
    if (!uploads || !ik) throw AppError.validation([{ path: 'screenshots', message: 'ImageKit uploads are not configured on the server; use POST /v1/beta/uploads/screenshot-url' }], 'Uploads unavailable');
    const a = ik.authParams();
    return {
      upload_url: 'https://upload.imagekit.io/api/v1/files/upload',
      public_key: ik.publicKey,
      token: a.token, expire: a.expire, signature: a.signature,
      folder: ik.folder, use_unique_file_name: true, tags: ['luna-feedback', 'beta'],
      transformation: { pre: SCREENSHOT_PRE_TRANSFORMATION },
      max_bytes: uploads.maxBytes, max_count: uploads.maxCount, accepted_types: [...SCREENSHOT_TYPES],
      client_resize: SCREENSHOT_CLIENT_RESIZE,
      url_endpoint: ik.urlEndpoint,
    };
  });

  /** An S3 upload link for a beta user's screenshot: the same as POST /v1/uploads/screenshot-url, for users on the list only. */
  app.post('/v1/beta/uploads/screenshot-url', async (req) => {
    const parsed = z.object({ user_id: UserId }).passthrough().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    await requireBeta(parsed.data.user_id);
    return screenshotUploadTarget(uploads, req.body);
  });

  // ---- Settings -------------------------------------------------------------------------------

  app.get('/v1/admin/beta-users', async () => {
    const items = await beta.list();
    return { items, count: items.length };
  });

  /**
   * Adds users: `users` with names, or bare `user_ids`. An id already on the list takes the name
   * sent with it (`renamed`); otherwise it is reported in `already`, not as an error.
   */
  app.post('/v1/admin/beta-users', { onRequest: requirePermission('manage_beta_users') }, async (req, reply) => {
    const tooMany = `at most ${MAX_IDS_PER_CHANGE} at a time`;
    const parsed = z.object({
      users: z.array(z.object({ user_id: UserId, name: Name.optional() }).strict()).max(MAX_IDS_PER_CHANGE, tooMany).optional(),
      user_ids: z.array(UserId).max(MAX_IDS_PER_CHANGE, tooMany).optional(),
    }).strict().refine((b) => (b.users?.length ?? 0) + (b.user_ids?.length ?? 0) > 0, { message: 'send at least one user id' }).safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    // One entry per id; a name given anywhere wins over none.
    const byId = new Map<number, string | null>();
    const all = [...(parsed.data.user_ids ?? []).map((user_id) => ({ user_id, name: null })), ...(parsed.data.users ?? [])];
    for (const u of all) byId.set(u.user_id, u.name ?? byId.get(u.user_id) ?? null);
    if (byId.size > MAX_IDS_PER_CHANGE) throw AppError.validation([{ path: 'users', message: tooMany }]);
    const entries: BetaUserEntry[] = [...byId].map(([user_id, name]) => ({ user_id, name }));
    const { added, renamed } = await beta.add(entries, actorOf(req));
    const changed = new Set([...added, ...renamed]);
    return reply.code(added.length ? 201 : 200).send({
      added, renamed, already: [...byId.keys()].filter((id) => !changed.has(id)).sort((a, b) => a - b), count: await beta.count(),
    });
  });

  /** Gives a beta user a name, or with "" / null takes it away. */
  app.patch<{ Params: { userId: string } }>('/v1/admin/beta-users/:userId', { onRequest: requirePermission('manage_beta_users') }, async (req) => {
    const id = UserId.safeParse(req.params.userId);
    if (!id.success) throw AppError.validation(zodIssues(id.error).map((i) => ({ ...i, path: 'user_id' })));
    const parsed = z.object({ name: Name }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    if (!(await beta.rename(id.data, parsed.data.name))) throw AppError.notFound(`${id.data} is not a beta user`);
    return { user_id: id.data, name: parsed.data.name };
  });

  /** Takes user ids off the list. Their reports stay, still marked beta. */
  app.post('/v1/admin/beta-users/remove', { onRequest: requirePermission('manage_beta_users') }, async (req) => {
    const parsed = z.object({
      user_ids: z.array(UserId).min(1, 'send at least one user id').max(MAX_IDS_PER_CHANGE, `at most ${MAX_IDS_PER_CHANGE} at a time`),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const ids = [...new Set(parsed.data.user_ids)];
    const removed = await beta.remove(ids);
    const removedSet = new Set(removed);
    return { removed, not_listed: ids.filter((id) => !removedSet.has(id)).sort((a, b) => a - b), count: await beta.count() };
  });
}
