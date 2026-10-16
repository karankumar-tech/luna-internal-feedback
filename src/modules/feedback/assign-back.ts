import type { SubmissionStatus } from './feedback.repo.js';

/**
 * A report marked Fixed or Won't fix goes back to whoever filed it, to check the fix or accept the
 * decision. When the reporter has no dashboard account (CX reports, testers without one) it goes to
 * QC's default owners instead, in order.
 */
export const ASSIGN_BACK_STATUSES: readonly SubmissionStatus[] = ['fixed', 'wont_fix'];

/** Dashboard user ids (luna_feedback.dashboard_users.id on production). The first one not disabled wins. */
export const ASSIGN_BACK_DEFAULTS = [
  { id: '64967caf-9375-4faf-a5ee-1b021e6e73a6', name: 'Kuldeep Sachan' },
  { id: '48147871-efc8-4de9-83b6-8b84c4b13e87', name: 'Shaifali' },
] as const;

export interface ActiveAccount { id: string; email: string }

/**
 * Who it goes to: the first reporter address (the dashboard account that filed it, then the report's
 * email) that belongs to an active account, else the first active default. Null when none is active.
 */
export function assignBackTo(reporters: (string | null | undefined)[], accounts: ActiveAccount[]): { email: string; reason: 'reporter' | 'default' } | null {
  for (const r of reporters) {
    const a = r ? accounts.find((x) => x.email.toLowerCase() === r.trim().toLowerCase()) : undefined;
    if (a) return { email: a.email, reason: 'reporter' };
  }
  for (const d of ASSIGN_BACK_DEFAULTS) {
    const a = accounts.find((x) => x.id === d.id);
    if (a) return { email: a.email, reason: 'default' };
  }
  return null;
}
