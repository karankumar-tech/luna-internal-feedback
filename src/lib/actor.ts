import type { FastifyRequest } from 'fastify';

/**
 * Who is making a request.
 *
 * Until per-user accounts land (phase 2) every dashboard caller is an admin, because the
 * only credential is the shared DASHBOARD_KEY. Routes already record `actorOf(req)` on the
 * rows they change and check `can(...)`, so switching to real accounts is a change to how
 * the actor is built, not a change to every route.
 */
export const ROLES = ['admin', 'qc', 'developer', 'business', 'cx'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string | null;
  email: string | null;
  name: string | null;
  role: Role;
  /** Which credential got them in. */
  via: 'admin_key' | 'app_key' | 'cx_key' | 'session' | 'cron';
}

/** What a role is allowed to do. Read access to feedback and diagnoses is common to all. */
export const PERMISSIONS = {
  /** Add, remove and rename dashboard users; reset anyone's password. */
  manage_users: ['admin'],
  /** Create and update Jira tickets from a submission or an issue kind. */
  manage_jira: ['admin', 'qc'],
  /** Move a ticket through triage and flag it as test data. */
  manage_triage: ['admin', 'qc'],
  /** Put tags on a report (app, firmware, …) and take them off. */
  tag_reports: ['admin', 'qc', 'developer'],
  /** Set or clear the date a report's fix is planned to go live. */
  set_go_live: ['admin', 'qc', 'developer'],
  /** Create, edit and link issue kinds; confirm or reject suggested links; merge kinds. */
  manage_kinds: ['admin', 'qc', 'developer'],
  /** Say "this report looks like that problem" for someone who can manage kinds to confirm. */
  suggest_kinds: ['admin', 'qc', 'developer', 'cx'],
  /** Write notes on a report: internal, or customer-safe for CX to pass on. */
  add_notes: ['admin', 'qc', 'developer', 'cx'],
  /** Spend money: run a diagnosis or send a chat message to the model. CX may, on the reports they look at. */
  run_diagnosis: ['admin', 'qc', 'developer', 'cx'],
  /** Record agreement with a verdict. */
  review_diagnosis: ['admin', 'qc', 'developer'],
  /** Edit the issue-category master list. */
  manage_categories: ['admin', 'qc'],
  /** Delete every test submission. */
  delete_test_data: ['admin'],
  /** Import device benchmark sessions from a health export, and tag, edit or delete them. */
  manage_benchmarks: ['admin', 'qc', 'developer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(actor: Actor | undefined, permission: Permission): boolean {
  if (!actor) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);
}

/** Every permission as true/false for this actor, for pages to show or hide controls. */
export function permissionsOf(actor: Actor | undefined): Record<Permission, boolean> {
  return Object.fromEntries((Object.keys(PERMISSIONS) as Permission[]).map((p) => [p, can(actor, p)])) as Record<Permission, boolean>;
}

/**
 * Whether a request is someone on the team acting on a report (a dashboard session, or automation
 * with the admin key). Only those start the response clock; the app, the CX tool and cron do not.
 */
export function isTeamAction(req: FastifyRequest): boolean {
  return req.actor?.via === 'session' || req.actor?.via === 'admin_key';
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
