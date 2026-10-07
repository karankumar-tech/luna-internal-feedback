import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { ROLES, permissionsOf } from '../../lib/actor.js';
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
    const [password, reporter_profile] = actor.id
      ? await Promise.all([service.passwordState(actor.id), service.reporterProfile(actor.id)])
      : [{ must_change: false, reason: null, age_days: 0 }, {}];
    return {
      id: actor.id, email: actor.email, name: actor.name, role: actor.role, via: actor.via,
      password,
      /** What they last entered about themselves on the Report page; the page prefills from it. */
      reporter_profile,
      password_rules: service.passwordRules,
      permissions: permissionsOf(actor),
    };
  });

  /**
   * Remembers what this person enters about themselves on the Report page (Luna user id, email,
   * ring serial, phone and ring details), so it is prefilled next time on any browser. Keys sent
   * are merged in; null removes one. The values stay editable on the page.
   */
  app.patch('/v1/me/reporter', async (req) => {
    const actor = req.actor;
    if (!actor?.id) throw AppError.forbidden('Only a signed-in account can save a reporter profile');
    const str = (max: number) => z.string().trim().max(max).nullable().optional();
    const parsed = z.object({
      user_id: z.number().int().positive().nullable().optional(),
      email: z.string().trim().email().max(254).nullable().optional(),
      device_serial: str(64),
      environment: z.enum(['stage', 'uat', 'production']).nullable().optional(),
      platform: z.enum(['ios', 'android']).nullable().optional(),
      app_version: str(200), build_number: str(200), firmware_version: str(200), os_version: str(200),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const patch = Object.fromEntries(Object.entries(parsed.data).map(([k, v]) => [k, v === '' ? null : v]));
    return { reporter_profile: await service.saveReporterProfile(actor.id, patch) };
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
