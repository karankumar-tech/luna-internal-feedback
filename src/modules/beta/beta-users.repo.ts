import type { Db } from '../../db/pool.js';

export interface BetaUserRow {
  user_id: number;
  /** A label QC gave them, to tell who is who. Dashboard only. */
  name: string | null;
  added_by: string | null;
  added_at: string;
  /** Reports this user has sent as a beta user. */
  reports: number;
}

/** One id to add, with the name to give it (null leaves an existing name as it is). */
export interface BetaUserEntry { user_id: number; name: string | null }

interface Snapshot {
  /** User id → name. */
  users: Map<number, string | null>;
  loadedAt: number;
}

/** After a failed reload, the copy already held is trusted this much longer before trying again. */
const RETRY_AFTER_ERROR_MS = 30_000;

/**
 * The beta list. Every app launch asks whether its user is on it, so the whole list (a couple of
 * thousand ids at most) is held in memory and read from the database once per TTL. Edits call
 * invalidate() so they show at once on this instance; other instances (serverless) pick them up
 * within the TTL. If a reload fails, the copy already held keeps answering.
 */
export class BetaUsersRepo {
  private snapshot: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
    private readonly onReloadError: (err: unknown) => void = () => {},
  ) {}

  invalidate(): void {
    this.snapshot = undefined;
  }

  private async load(): Promise<Snapshot> {
    const { rows } = await this.db.query<{ user_id: string; name: string | null }>('select user_id, name from luna_feedback.beta_users');
    return { users: new Map(rows.map((r) => [Number(r.user_id), r.name ?? null])), loadedAt: Date.now() };
  }

  private async users(): Promise<Map<number, string | null>> {
    const held = this.snapshot;
    if (held && Date.now() - held.loadedAt < this.ttlMs) return held.users;
    if (!this.inflight) {
      this.inflight = this.load()
        .then((s) => { this.snapshot = s; return s; })
        .catch((err) => {
          if (!held) throw err;
          this.onReloadError(err);
          // Keep answering from what we have; try the database again shortly.
          const kept = { users: held.users, loadedAt: Date.now() - this.ttlMs + RETRY_AFTER_ERROR_MS };
          this.snapshot = kept;
          return kept;
        })
        .finally(() => { this.inflight = undefined; });
    }
    return (await this.inflight).users;
  }

  async has(userId: number): Promise<boolean> {
    return (await this.users()).has(userId);
  }

  /** The names QC gave these ids, from memory. Ids without a name (or off the list) are left out. */
  async namesFor(userIds: number[]): Promise<Map<number, string>> {
    const users = await this.users();
    const out = new Map<number, string>();
    for (const id of userIds) { const name = users.get(id); if (name) out.set(id, name); }
    return out;
  }

  /** The list for Settings, newest first, straight from the database. */
  async list(): Promise<BetaUserRow[]> {
    const { rows } = await this.db.query<{ user_id: string; name: string | null; added_by: string | null; added_at: Date; reports: number }>(
      `select b.user_id, b.name, b.added_by, b.added_at,
              (select count(*) from luna_feedback.submissions s where s.origin = 'beta' and s.user_id = b.user_id)::int as reports
         from luna_feedback.beta_users b
        order by b.added_at desc, b.user_id`,
    );
    return rows.map((r) => ({ user_id: Number(r.user_id), name: r.name, added_by: r.added_by, added_at: new Date(r.added_at).toISOString(), reports: r.reports }));
  }

  /**
   * Adds ids not on the list yet, with their names. An id already there keeps its place and takes
   * the new name when one is given. Each id once: the caller merges repeats.
   */
  async add(entries: BetaUserEntry[], by: string | null): Promise<{ added: number[]; renamed: number[] }> {
    if (!entries.length) return { added: [], renamed: [] };
    const { rows } = await this.db.query<{ user_id: string; inserted: boolean }>(
      `insert into luna_feedback.beta_users (user_id, name, added_by)
       select u.id, u.name, $3 from unnest($1::bigint[], $2::text[]) as u(id, name)
       on conflict (user_id) do update set name = excluded.name
         where excluded.name is not null and beta_users.name is distinct from excluded.name
       returning user_id, (xmax = 0) as inserted`,
      [entries.map((e) => e.user_id), entries.map((e) => e.name), by],
    );
    this.invalidate();
    const ids = (inserted: boolean) => rows.filter((r) => r.inserted === inserted).map((r) => Number(r.user_id)).sort((a, b) => a - b);
    return { added: ids(true), renamed: ids(false) };
  }

  /** Sets or (with null) clears the name. False when the id is not on the list. */
  async rename(userId: number, name: string | null): Promise<boolean> {
    const r = await this.db.query('update luna_feedback.beta_users set name = $2 where user_id = $1', [userId, name]);
    this.invalidate();
    return (r.rowCount ?? 0) > 0;
  }

  /** Takes ids off the list. Returns the ones that were on it. Their reports stay as they are. */
  async remove(userIds: number[]): Promise<number[]> {
    if (!userIds.length) return [];
    const { rows } = await this.db.query<{ user_id: string }>(
      'delete from luna_feedback.beta_users where user_id = any($1::bigint[]) returning user_id',
      [userIds],
    );
    this.invalidate();
    return rows.map((r) => Number(r.user_id)).sort((a, b) => a - b);
  }

  async count(): Promise<number> {
    return (await this.users()).size;
  }
}
