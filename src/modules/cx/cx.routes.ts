import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
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
  /** The recurring problems this report has been grouped under, if any. */
  problems: { ref: string; title: string; status: string }[];
  /** Opens the report on the dashboard, for agents with an account. */
  dashboard_url: string;
}

/**
 * The CX tool's API. An agent checks that a customer's problem is real, then presses a button in
 * that tool, which posts here with CX_API_KEY. The key, not the body, makes it a CX report.
 */
export function registerCxRoutes(
  app: FastifyInstance,
  deps: { feedback: FeedbackService; kinds: KindsService; publicBaseUrl: string },
) {
  const { feedback, kinds } = deps;
  const base = deps.publicBaseUrl.replace(/\/+$/, '');

  async function view(dto: SubmissionDto): Promise<CxReportView> {
    const links = await kinds.forSubmission(dto.id);
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
      problems: links.map((k) => ({ ref: k.ref, title: k.title, status: k.status })),
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
}
