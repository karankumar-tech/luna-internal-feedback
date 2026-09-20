import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { ROLES, can } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.js';
import type { UsersService } from './users.service.js';

const Password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

const CreateBody = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().max(120).nullish(),
  role: z.enum(ROLES),
  /** Omit and the server generates one, returned once in the response. */
  password: Password.optional(),
}).strict();

const PatchBody = z.object({
  name: z.string().trim().max(120).nullish(),
  role: z.enum(ROLES).optional(),
  is_disabled: z.boolean().optional(),
}).strict();

export function registerUserRoutes(app: FastifyInstance, deps: { service: UsersService }) {
  const { service } = deps;
  const adminOnly = { onRequest: requirePermission('manage_users') };

  /** Who am I, and must I rotate before doing anything else? Read by every dashboard page. */
  app.get('/v1/me', async (req) => {
    const actor = req.actor;
    if (!actor) throw AppError.unauthorized('Not signed in');
    const password = actor.id ? await service.passwordState(actor.id) : { must_change: false, reason: null, age_days: 0 };
    return {
      id: actor.id, email: actor.email, name: actor.name, role: actor.role, via: actor.via,
      password,
      password_rules: service.passwordRules,
      permissions: {
        manage_users: can(actor, 'manage_users'),
        manage_jira: can(actor, 'manage_jira'),
        manage_triage: can(actor, 'manage_triage'),
        manage_kinds: can(actor, 'manage_kinds'),
        run_diagnosis: can(actor, 'run_diagnosis'),
        review_diagnosis: can(actor, 'review_diagnosis'),
        manage_categories: can(actor, 'manage_categories'),
        delete_test_data: can(actor, 'delete_test_data'),
      },
    };
  });

  /** Changing your own password. Allowed even while must_change is set — that is the point. */
  app.post('/v1/me/password', async (req) => {
    const actor = req.actor;
    if (!actor?.id) throw AppError.forbidden('Only a signed-in account can change a password here');
    const parsed = z.object({
      current_password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
      new_password: Password,
    }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const user = await service.changeOwnPassword(actor.id, parsed.data.current_password, parsed.data.new_password);
    return { user, rules: service.passwordRules };
  });

  app.get('/v1/admin/users', { ...adminOnly }, async () => ({
    items: await service.list(),
    rules: service.passwordRules,
  }));

  app.get('/v1/admin/users/events', { ...adminOnly }, async () => ({ items: await service.events(60) }));

  app.post('/v1/admin/users', { ...adminOnly }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const out = await service.create(parsed.data, req.actor!);
    // generated_password is the only time the password is ever readable; it is not stored.
    return reply.code(201).send(out);
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/users/:id', { ...adminOnly }, async (req) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.update(req.params.id, {
      ...parsed.data,
      name: parsed.data.name === undefined ? undefined : parsed.data.name ?? null,
    }, req.actor!);
  });

  /** Admin override: issue a new password and hand it back once for the admin to pass on. */
  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/password', { ...adminOnly }, async (req) => {
    const parsed = z.object({ password: Password.optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.resetPassword(req.params.id, req.actor!, parsed.data.password);
  });

  app.delete<{ Params: { id: string } }>('/v1/admin/users/:id', { ...adminOnly }, async (req) => {
    await service.remove(req.params.id, req.actor!);
    return { deleted: true };
  });
}
