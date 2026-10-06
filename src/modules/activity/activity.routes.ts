import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf, can, isTeamAction } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { PRIORITIES, SUBMISSION_STATUSES } from '../feedback/feedback.repo.js';
import type { FeedbackService } from '../feedback/feedback.service.js';
import type { KindsService } from '../kinds/kinds.service.js';
import { NOTE_VISIBILITIES, type ActivityRepo } from './activity.repo.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw AppError.validation(zodIssues(r.error));
  return r.data;
}

export function registerActivityRoutes(app: FastifyInstance, deps: {
  feedback: FeedbackService;
  activity: ActivityRepo;
  kinds: KindsService;
  assignable: () => Promise<{ email: string; name: string | null; role: string }[]>;
}) {
  const { feedback, activity, kinds } = deps;

  /** A report's history and notes, oldest first. */
  app.get<{ Params: { id: string } }>('/v1/feedback/:id/activity', async (req) => {
    const sub = await feedback.row(req.params.id);
    const items = await activity.list(sub.id);
    return { items: items.map((e) => ({ ...e, created_at: new Date(e.created_at).toISOString() })) };
  });

  /** A note: internal for the team, or customer-safe for CX to pass on. */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/notes', { onRequest: requirePermission('add_notes') }, async (req, reply) => {
    const body = parse(z.object({
      body: z.string().trim().min(1, 'write something').max(4000),
      visibility: z.enum(NOTE_VISIBILITIES).default('internal'),
    }).strict(), req.body);
    const e = await feedback.addNote(req.params.id, body.body, body.visibility ?? 'internal', actorOf(req), isTeamAction(req));
    return reply.code(201).send({ ...e, created_at: new Date(e.created_at).toISOString() });
  });

  /** Ask the reporter (tester, or the customer through CX) and park the report as needs_info. */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/ask-reporter', { onRequest: requirePermission('manage_triage') }, async (req) => {
    const body = parse(z.object({ questions: z.array(z.string().trim().min(3).max(300)).min(1).max(5) }).strict(), req.body);
    return feedback.askReporter(req.params.id, body.questions, actorOf(req));
  });

  /** One change applied to many reports from the dashboard list. Each report is logged on its own. */
  app.post('/v1/admin/submissions/bulk', { onRequest: requirePermission('manage_triage') }, async (req) => {
    const body = parse(z.object({
      ids: z.array(z.string().trim().min(1).max(60)).min(1).max(200),
      status: z.enum(SUBMISSION_STATUSES).optional(),
      assigned_to: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
      priority: z.enum(PRIORITIES).nullable().optional(),
      is_test: z.boolean().optional(),
      kind_id: z.string().trim().max(60).optional(),
      add_tags: z.array(z.string().max(40)).max(10).optional(),
      remove_tags: z.array(z.string().max(40)).max(10).optional(),
    }).strict().refine((b) => b.status !== undefined || b.assigned_to !== undefined || b.priority !== undefined || b.is_test !== undefined || b.kind_id !== undefined || !!b.add_tags?.length || !!b.remove_tags?.length, {
      message: 'send at least one of status, assigned_to, priority, is_test, kind_id, add_tags, remove_tags',
    }), req.body);
    if (body.kind_id && !can(req.actor, 'manage_kinds')) throw AppError.forbidden(`Your role (${req.actor?.role}) cannot link problems`);
    if (body.assigned_to && !(await deps.assignable()).some((u) => u.email === body.assigned_to)) {
      throw AppError.validation([{ path: 'assigned_to', message: `${body.assigned_to} has no dashboard account` }]);
    }

    const by = actorOf(req);
    const team = isTeamAction(req);
    const failed: { id: string; error: string }[] = [];
    let updated = 0;
    for (const id of [...new Set(body.ids)]) {
      try {
        if (body.is_test !== undefined) await feedback.setTestFlag(id, body.is_test, by);
        if (body.assigned_to !== undefined) await feedback.assign(id, body.assigned_to, by);
        if (body.priority !== undefined) await feedback.setPriority(id, body.priority, by);
        if (body.status !== undefined) await feedback.setStatus(id, body.status, null, by, team);
        if (body.kind_id) await kinds.link((await feedback.row(id)).id, body.kind_id, 'manual', null, by);
        if (body.add_tags?.length || body.remove_tags?.length) await feedback.changeTags(id, { add: body.add_tags, remove: body.remove_tags }, by);
        updated += 1;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { updated, failed };
  });

  /** Everyone a report can be assigned to. */
  app.get('/v1/admin/assignees', async () => ({ items: await deps.assignable() }));
}
