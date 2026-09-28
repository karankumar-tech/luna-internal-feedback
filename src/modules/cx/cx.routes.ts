import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { ActivityRepo } from '../activity/activity.repo.js';
import type { FeedbackService, SubmissionDto } from '../feedback/feedback.service.js';
import type { KindsService } from '../kinds/kinds.service.js';

/**
 * What the CX tool sees of a report: enough to show the agent where it stands and to quote the
 * reference to the customer. Internal notes, AI output and other reports stay on the dashboard.
 */
export interface CxReportView {
  id: string;
  ref: string;
  feature_key: string;
  is_positive: boolean;
  occurred_on: string;
  environment: string;
  device_serial: string | null;
  cx: { ref: string | null; url: string | null; channel: string | null; agent: string | null };
  status: string;
  status_changed_at: string | null;
  created_at: string;
  created_at_ist: string;
  /** The recurring problems this report has been confirmed as part of. */
  problems: { ref: string; title: string; status: string; report_count: number }[];
  /** The open problem it most likely belongs to, not confirmed yet: show it to the agent as "Looks like …". */
  likely_problem: { ref: string; title: string; report_count: number } | null;
  /** The team's latest customer-safe update: something CX can pass on to the customer as is. */
  latest_update: { body: string; at: string } | null;
  /** Opens the report on the dashboard, for agents with an account. */
  dashboard_url: string;
}

/**
 * The CX tool's API. An agent checks that a customer's problem is real, then presses a button in
 * that tool, which posts here with CX_API_KEY. The key, not the body, makes it a CX report.
 */
export function registerCxRoutes(
  app: FastifyInstance,
  deps: { feedback: FeedbackService; kinds: KindsService; activity: ActivityRepo; publicBaseUrl: string },
) {
  const { feedback, kinds, activity } = deps;
  const base = deps.publicBaseUrl.replace(/\/+$/, '');

  async function view(dto: SubmissionDto): Promise<CxReportView> {
    const [links, update] = await Promise.all([kinds.forSubmissionWithCounts(dto.id, dto.is_test), activity.latestCustomerNote(dto.id)]);
    const likely = links.find((k) => k.state === 'suggested');
    return {
      id: dto.id,
      ref: dto.ref,
      feature_key: dto.feature_key,
      is_positive: dto.is_positive,
      occurred_on: dto.occurred_on,
      environment: dto.environment,
      device_serial: dto.device_serial,
      cx: { ref: dto.cx_ref, url: dto.cx_url, channel: dto.cx_channel, agent: dto.cx_agent },
      status: dto.status,
      status_changed_at: dto.status_changed_at,
      created_at: dto.created_at,
      created_at_ist: dto.created_at_ist,
      problems: links.filter((k) => k.state === 'linked').map((k) => ({ ref: k.ref, title: k.title, status: k.status, report_count: k.counts?.count ?? 0 })),
      likely_problem: likely ? { ref: likely.ref, title: likely.title, report_count: likely.counts?.count ?? 0 } : null,
      latest_update: update?.note ? { body: update.note, at: new Date(update.created_at).toISOString() } : null,
      dashboard_url: `${base}/i/${dto.ref}`,
    };
  }

  /** File a customer's problem. 201 when new; 200 with the first report when this CX ticket was already filed for this feature. */
  app.post<{ Params: { feature: string } }>('/v1/cx/feedback/:feature', async (req, reply) => {
    const via = req.actor?.via === 'cx_key' ? 'cx_tool' : 'admin';
    const { dto, created } = await feedback.submitCx(req.params.feature, req.body, via, req.log);
    return reply.code(created ? 201 : 200).send(await view(dto));
  });

  /** Where a CX report stands, by reference (LN-00042) or id. Internal reports are not readable here. */
  app.get<{ Params: { ref: string } }>('/v1/cx/feedback/:ref', async (req) => {
    const dto = await feedback.get(req.params.ref);
    if (dto.origin !== 'cx') throw AppError.notFound('Submission not found');
    return view(dto);
  });

  /**
   * A note from the CX tool, e.g. what the customer replied. The text is redacted like the rest of
   * the report. When the report was waiting on the customer (needs_info), it goes back to where it was.
   */
  app.post<{ Params: { ref: string } }>('/v1/cx/feedback/:ref/notes', async (req, reply) => {
    const parsed = z.object({
      body: z.string().trim().min(1, 'write something').max(4000),
      agent: z.string().trim().max(120).optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const dto = await feedback.get(req.params.ref);
    if (dto.origin !== 'cx') throw AppError.notFound('Submission not found');
    const by = `cx_tool${parsed.data.agent ? ` · ${parsed.data.agent}` : ''}`;
    await feedback.addNote(dto.id, parsed.data.body, 'internal', by, false);
    const reopened = await feedback.reopenAfterReply(dto.id, by);
    return reply.code(201).send(await view(reopened ?? (await feedback.get(dto.id))));
  });
}
