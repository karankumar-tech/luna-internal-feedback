import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { DiagnosisService } from './diagnosis.service.js';
import type { DiagnosisRepo } from './diagnosis.repo.js';

const ReviewBody = z.object({
  verdict: z.enum(['agree', 'disagree', 'unsure']),
  note: z.string().trim().max(1000).optional().nullable(),
  reviewer: z.string().trim().max(120).optional().nullable(),
}).strict();

const uuid = (v: string) => z.string().uuid().safeParse(v).success;

export function registerDiagnosisRoutes(app: FastifyInstance, deps: { service: DiagnosisService; repo: DiagnosisRepo }) {
  const { service, repo } = deps;

  app.get<{ Params: { id: string } }>('/v1/feedback/:id/diagnosis', async (req) => {
    if (!uuid(req.params.id)) throw AppError.notFound('Submission not found');
    const d = await service.get(req.params.id);
    if (!d) throw AppError.notFound('No diagnosis for this submission');
    return d;
  });

  app.get<{ Params: { id: string } }>('/v1/admin/submissions/:id/diagnosis/runs', async (req) => {
    if (!uuid(req.params.id)) throw AppError.notFound('Submission not found');
    return { items: await repo.runs(req.params.id) };
  });

  /** Synchronous run (or re-run). Returns the finished diagnosis. */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/diagnose', async (req) => {
    if (!uuid(req.params.id)) throw AppError.notFound('Submission not found');
    return service.run(req.params.id, 'manual');
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/submissions/:id/diagnosis/review', async (req) => {
    if (!uuid(req.params.id)) throw AppError.notFound('Submission not found');
    const parsed = ReviewBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.review(req.params.id, parsed.data.verdict, parsed.data.note ?? null, parsed.data.reviewer ?? null);
  });

  /** Sweep due jobs. POST from the dashboard; GET from the nightly Vercel cron (auth via CRON_SECRET in the auth hook). */
  const sweep = async (req: { query: unknown }) => {
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 5) || 5, 1), 20);
    const results = await service.runPending(limit);
    return { ran: results.length, results: results.map((r) => ({ submission_id: r.submission_id, status: r.status, reason: r.reason ?? null })) };
  };
  app.post('/v1/admin/diagnoses/run-pending', sweep);
  app.get('/v1/admin/diagnoses/run-pending', sweep);

  app.get('/v1/admin/diagnoses/summary', async () => ({ enabled: service.enabled, ...(await repo.summary()) }));

  app.get('/v1/admin/diagnoses/overview', async (req) => {
    const q = req.query as { from?: string; to?: string; include_test?: string };
    const isDate = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const to = isDate(q.to) ? q.to! : new Date().toISOString().slice(0, 10);
    const from = isDate(q.from) ? q.from! : new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw AppError.validation([{ path: 'from', message: 'must not be after to' }], 'Invalid query');
    return repo.overview(from, to, q.include_test === 'true');
  });

  app.get('/v1/admin/logs/lookup', async (req) => {
    const q = req.query as { serial_no?: string; email?: string };
    return { items: await service.lookup({ serial_no: q.serial_no?.trim() || undefined, email: q.email?.trim() || undefined }) };
  });
}
