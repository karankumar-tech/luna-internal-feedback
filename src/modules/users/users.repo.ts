import type { Db } from '../../db/pool.js';
import type { Role } from '../../lib/actor.js';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  password_hash: string;
  password_set_at: Date;
  must_change: boolean;
  is_disabled: boolean;
  last_login_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What leaves the API. The hash never does. */
export type PublicUser = Omit<UserRow, 'password_hash' | 'password_set_at' | 'last_login_at' | 'locked_until' | 'created_at' | 'updated_at'> & {
  password_set_at: string;
  last_login_at: string | null;
  locked_until: string | null;
  created_at: string;
  password_age_days: number;
  password_expired: boolean;
};

const U_COLS = `id, email, name, role, password_hash, password_set_at, must_change, is_disabled,
  last_login_at, failed_attempts, locked_until, created_by, created_at, updated_at`;

export class UsersRepo {
  constructor(private readonly db: Db) {}

  async count(): Promise<number> {
    const r = await this.db.query<{ n: number }>('select count(*)::int as n from luna_feedback.dashboard_users');
    return r.rows[0]!.n;
  }

  async byEmail(email: string): Promise<UserRow | undefined> {
    const r = await this.db.query<UserRow>(`select ${U_COLS} from luna_feedback.dashboard_users where email = $1`, [email.trim().toLowerCase()]);
    return r.rows[0];
  }

  async byId(id: string): Promise<UserRow | undefined> {
    const r = await this.db.query<UserRow>(`select ${U_COLS} from luna_feedback.dashboard_users where id = $1`, [id]);
    return r.rows[0];
  }

  async list(): Promise<UserRow[]> {
    const r = await this.db.query<UserRow>(`select ${U_COLS} from luna_feedback.dashboard_users order by is_disabled, role, email`);
    return r.rows;
  }

  async create(u: { email: string; name: string | null; role: Role; passwordHash: string; mustChange: boolean; createdBy: string | null }): Promise<UserRow> {
    const r = await this.db.query<UserRow>(
      `insert into luna_feedback.dashboard_users (email, name, role, password_hash, must_change, created_by)
       values ($1,$2,$3,$4,$5,$6) returning ${U_COLS}`,
      [u.email.trim().toLowerCase(), u.name, u.role, u.passwordHash, u.mustChange, u.createdBy],
    );
    return r.rows[0]!;
  }

  async update(id: string, patch: Partial<Pick<UserRow, 'name' | 'role' | 'is_disabled'>>): Promise<UserRow | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [col, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      vals.push(value);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return this.byId(id);
    const r = await this.db.query<UserRow>(`update luna_feedback.dashboard_users set ${sets.join(', ')} where id = $1 returning ${U_COLS}`, vals);
    return r.rows[0];
  }

  /** Replaces the password, files the old hash in history and clears any lockout. */
  async setPassword(id: string, hash: string, mustChange: boolean): Promise<UserRow | undefined> {
    const current = await this.byId(id);
    if (!current) return undefined;
    await this.db.query(
      `insert into luna_feedback.dashboard_password_history (user_id, password_hash) values ($1, $2)`,
      [id, current.password_hash],
    );
    // Keep only the most recent few; the reuse check never looks further back.
    await this.db.query(
      `delete from luna_feedback.dashboard_password_history
        where user_id = $1
          and id not in (select id from luna_feedback.dashboard_password_history where user_id = $1 order by created_at desc limit 10)`,
      [id],
    );
    const r = await this.db.query<UserRow>(
      `update luna_feedback.dashboard_users
          set password_hash = $2, password_set_at = now(), must_change = $3, failed_attempts = 0, locked_until = null
        where id = $1 returning ${U_COLS}`,
      [id, hash, mustChange],
    );
    return r.rows[0];
  }

  /** Recent hashes to compare a proposed password against, newest first. */
  async recentHashes(id: string, limit: number): Promise<string[]> {
    const r = await this.db.query<{ password_hash: string }>(
      `select password_hash from luna_feedback.dashboard_password_history where user_id = $1 order by created_at desc limit $2`,
      [id, limit],
    );
    return r.rows.map((x) => x.password_hash);
  }

  async recordLogin(id: string): Promise<void> {
    await this.db.query(
      `update luna_feedback.dashboard_users set last_login_at = now(), failed_attempts = 0, locked_until = null where id = $1`,
      [id],
    );
  }

  /** Counts a failure and locks the account once the threshold is crossed. */
  async recordFailure(id: string, maxAttempts: number, lockMinutes: number): Promise<void> {
    await this.db.query(
      `update luna_feedback.dashboard_users
          set failed_attempts = failed_attempts + 1,
              locked_until = case when failed_attempts + 1 >= $2 then now() + ($3::int * interval '1 minute') else locked_until end
        where id = $1`,
      [id, maxAttempts, lockMinutes],
    );
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.query('delete from luna_feedback.dashboard_users where id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async countAdmins(excludingId?: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `select count(*)::int as n from luna_feedback.dashboard_users
        where role = 'admin' and not is_disabled ${excludingId ? 'and id <> $1' : ''}`,
      excludingId ? [excludingId] : [],
    );
    return r.rows[0]!.n;
  }

  async logEvent(e: { actor: string | null; target: string | null; action: string; detail?: string | null }): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.dashboard_user_events (actor, target, action, detail) values ($1,$2,$3,$4)`,
      [e.actor, e.target, e.action, e.detail ?? null],
    );
  }

  async events(limit = 50): Promise<{ actor: string | null; target: string | null; action: string; detail: string | null; created_at: Date }[]> {
    const r = await this.db.query<{ actor: string | null; target: string | null; action: string; detail: string | null; created_at: Date }>(
      `select actor, target, action, detail, created_at from luna_feedback.dashboard_user_events order by created_at desc limit $1`,
      [limit],
    );
    return r.rows;
  }
}

export function toPublicUser(row: UserRow, maxAgeDays: number): PublicUser {
  const { password_hash: _hidden, ...rest } = row;
  const ageMs = Date.now() - new Date(row.password_set_at).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  return {
    ...rest,
    password_set_at: new Date(row.password_set_at).toISOString(),
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    locked_until: row.locked_until ? new Date(row.locked_until).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    password_age_days: ageDays,
    password_expired: maxAgeDays > 0 && ageDays >= maxAgeDays,
  };
}
