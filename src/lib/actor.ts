import type { FastifyRequest } from 'fastify';

/**
 * Who is making a request.
 *
 * Until per-user accounts land (phase 2) every dashboard caller is an admin, because the
 * only credential is the shared DASHBOARD_KEY. Routes already record `actorOf(req)` on the
 * rows they change and check `can(...)`, so switching to real accounts is a change to how
 * the actor is built, not a change to every route.
 */
export const ROLES = ['admin', 'qc', 'developer', 'business'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string | null;
  email: string | null;
  name: string | null;
  role: Role;
  /** Which credential got them in. */
  via: 'admin_key' | 'app_key' | 'session' | 'cron';
}

/** What a role is allowed to do. Read access to feedback and diagnoses is common to all. */
export const PERMISSIONS = {
  /** Add, remove and rename dashboard users; reset anyone's password. */
  manage_users: ['admin'],
  /** Create and update Jira tickets from a submission or an issue kind. */
  manage_jira: ['admin', 'qc'],
  /** Move a ticket through triage and flag it as test data. */
  manage_triage: ['admin', 'qc'],
  /** Create, edit and link issue kinds. */
  manage_kinds: ['admin', 'qc', 'developer'],
  /** Spend money: run a diagnosis or send a chat message to the model. */
  run_diagnosis: ['admin', 'qc', 'developer'],
  /** Record agreement with a verdict. */
  review_diagnosis: ['admin', 'qc', 'developer'],
  /** Edit the issue-category master list. */
  manage_categories: ['admin', 'qc'],
  /** Delete every test submission. */
  delete_test_data: ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(actor: Actor | undefined, permission: Permission): boolean {
  if (!actor) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);
}

/** Short label stored on audited rows: an email once accounts exist, else how they signed in. */
export function actorOf(req: FastifyRequest): string {
  const actor = req.actor;
  if (!actor) return 'unknown';
  return actor.email ?? actor.name ?? actor.via;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}
