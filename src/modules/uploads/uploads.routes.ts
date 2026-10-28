import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { SCREENSHOT_CLIENT_RESIZE, SCREENSHOT_TYPES, type ScreenshotUploads } from '../feedback/feedback.routes.js';
import { S3ScreenshotStore, VIEW_TTL_S } from './s3.js';

/** What a client says about the file before it gets an S3 upload link. */
export const UploadTargetBody = z.object({
  content_type: z.enum(SCREENSHOT_TYPES),
  size: z.number().int().positive(),
});

const unavailable = () => AppError.validation([{ path: 'screenshots', message: 'screenshot uploads are not configured on the server' }], 'Uploads unavailable');

/**
 * One presigned S3 upload link for a screenshot (S3 only; ImageKit uploads use the screenshot-auth routes).
 * PUT the file to `upload_url` with `headers`, then send `{ file_id, url }` with the report.
 */
export async function screenshotUploadTarget(uploads: ScreenshotUploads | null, body: unknown, opts: { maxCount?: number } = {}) {
  if (!uploads?.s3) throw unavailable();
  const parsed = UploadTargetBody.safeParse(body);
  if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
  if (parsed.data.size > uploads.maxBytes) {
    throw AppError.validation([{ path: 'size', message: `at most ${Math.round(uploads.maxBytes / 1048576)} MB; downscale first (see client_resize)` }]);
  }
  return {
    ...(await uploads.s3.uploadTarget(parsed.data.content_type, parsed.data.size)),
    max_bytes: uploads.maxBytes, max_count: opts.maxCount ?? uploads.maxCount, accepted_types: [...SCREENSHOT_TYPES],
    client_resize: SCREENSHOT_CLIENT_RESIZE,
  };
}

export function registerUploadRoutes(app: FastifyInstance, deps: { uploads: ScreenshotUploads | null }) {
  const { uploads } = deps;

  // ---- S3 upload link (the app, CX and the dashboard upload straight to S3) ----
  app.post('/v1/uploads/screenshot-url', async (req) => screenshotUploadTarget(uploads, req.body));

  /**
   * A screenshot stored in S3. Open (like an ImageKit link: the id is a random UUID), so the
   * dashboard, Jira and the diagnosis model can all load it; it redirects to a short-lived
   * presigned GET, so the bucket itself stays private.
   */
  app.get<{ Params: { fileId: string } }>('/v1/screenshots/:fileId', async (req, reply) => {
    if (!uploads?.s3 || !S3ScreenshotStore.isFileId(req.params.fileId)) throw AppError.notFound('No such screenshot');
    const target = await uploads.s3.viewUrl(req.params.fileId);
    return reply.header('cache-control', `private, max-age=${VIEW_TTL_S - 600}`).redirect(target, 302);
  });
}
