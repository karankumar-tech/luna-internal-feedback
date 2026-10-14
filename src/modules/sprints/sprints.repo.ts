import type pg from 'pg';
import type { Db } from '../../db/pool.js';
import type { Screenshot } from '../feedback/feedback.repo.js';

export const SPRINT_STATUSES = ['planned', 'active', 'closed'] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

export interface SprintRow {
  id: string;
  /** SPR-202610-01 */
  ref: string;
  name: string;
  goal: string | null;
  starts_on: string;
  ends_on: string;
  status: SprintStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  activated_at: Date | null;
  closed_by: string | null;
  closed_at: Date | null;
}

/** Real issues only (test data is left out, as on the Reports list), so the numbers match the list. */
export interface SprintCounts {
  issues: number;
  open: number;
  done: number;
  by_status: Record<string, number>;
  p0_open: number;
  p1_open: number;
  unassigned_open: number;
  /** Issues moved in when the sprint before closed. */
  carried_in: number;
  /** Issues that were still open when this sprint closed, and moved on. */
  carried_out: number;
  /** Open issues including test data: what decides whether the sprint can be deleted. */
  open_with_test: number;
}

/** The text that marks a carry-over move in a report's history; counts are read back from it. */
export const CARRIED_NOTE = 'Carried over when';

const COLS = `id, ref, name, goal, starts_on::text as starts_on, ends_on::text as ends_on, status,
  created_by, created_at, updated_at, activated_at, closed_by, closed_at`;
const TERMINAL = `('resolved','closed','wont_fix')`;

const EMPTY_COUNTS = (): SprintCounts => ({ issues: 0, open: 0, done: 0, by_status: {}, p0_open: 0, p1_open: 0, unassigned_open: 0, carried_in: 0, carried_out: 0, open_with_test: 0 });

type Q = Pick<pg.PoolClient, 'query'>;

export class SprintsRepo {
  constructor(private readonly db: Db, private readonly timeZone: string) {}

  /** Runs `fn` in one transaction on one connection. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Newest first. */
  async all(q: Q = this.db): Promise<SprintRow[]> {
    const r = await q.query<SprintRow>(`select ${COLS} from luna_feedback.sprints order by starts_on desc`);
    return r.rows;
  }

  async byRef(ref: string, q: Q = this.db, lock = false): Promise<SprintRow | undefined> {
    const r = await q.query<SprintRow>(`select ${COLS} from luna_feedback.sprints where ref = $1${lock ? ' for update' : ''}`, [ref]);
    return r.rows[0];
  }

  async byId(id: string, q: Q = this.db): Promise<SprintRow | undefined> {
    const r = await q.query<SprintRow>(`select ${COLS} from luna_feedback.sprints where id = $1`, [id]);
    return r.rows[0];
  }

  async active(q: Q = this.db, lock = false): Promise<SprintRow | undefined> {
    const r = await q.query<SprintRow>(`select ${COLS} from luna_feedback.sprints where status = 'active'${lock ? ' for update' : ''}`);
    return r.rows[0];
  }

  /** The earliest planned sprint starting after `after` (a date): "next" when `after` is the current sprint's start. */
  async plannedAfter(after: string, q: Q = this.db, lock = false): Promise<SprintRow | undefined> {
    const r = await q.query<SprintRow>(
      `select ${COLS} from luna_feedback.sprints where status = 'planned' and starts_on > $1::date order by starts_on limit 1${lock ? ' for update' : ''}`,
      [after],
    );
    return r.rows[0];
  }

  /** The sprint that ends last, whatever its state. */
  async latest(q: Q = this.db): Promise<SprintRow | undefined> {
    const r = await q.query<SprintRow>(`select ${COLS} from luna_feedback.sprints order by ends_on desc limit 1`);
    return r.rows[0];
  }

  /** Sprints whose dates touch [starts, ends], other than `exceptId`. */
  async overlapping(starts: string, ends: string, exceptId: string | null, q: Q = this.db): Promise<SprintRow[]> {
    const r = await q.query<SprintRow>(
      `select ${COLS} from luna_feedback.sprints
        where starts_on <= $2::date and ends_on >= $1::date and ($3::uuid is null or id <> $3::uuid)
        order by starts_on`,
      [starts, ends, exceptId],
    );
    return r.rows;
  }

  async insert(s: { ref: string; name: string; goal: string | null; starts_on: string; ends_on: string; status: SprintStatus; by: string | null }, q: Q = this.db): Promise<SprintRow> {
    const r = await q.query<SprintRow>(
      `insert into luna_feedback.sprints (ref, name, goal, starts_on, ends_on, status, created_by, activated_at)
       values ($1, $2, $3, $4::date, $5::date, $6, $7, case when $6 = 'active' then now() end)
       returning ${COLS}`,
      [s.ref, s.name, s.goal, s.starts_on, s.ends_on, s.status, s.by],
    );
    return r.rows[0]!;
  }

  async update(id: string, s: { name: string; goal: string | null; starts_on: string; ends_on: string }, q: Q = this.db): Promise<SprintRow> {
    const r = await q.query<SprintRow>(
      `update luna_feedback.sprints set name = $2, goal = $3, starts_on = $4::date, ends_on = $5::date, updated_at = now()
        where id = $1 returning ${COLS}`,
      [id, s.name, s.goal, s.starts_on, s.ends_on],
    );
    return r.rows[0]!;
  }

  async markClosed(id: string, by: string | null, q: Q): Promise<SprintRow> {
    const r = await q.query<SprintRow>(
      `update luna_feedback.sprints set status = 'closed', closed_by = $2, closed_at = now(), updated_at = now() where id = $1 returning ${COLS}`,
      [id, by],
    );
    return r.rows[0]!;
  }

  async markActive(id: string, q: Q): Promise<SprintRow> {
    const r = await q.query<SprintRow>(
      `update luna_feedback.sprints set status = 'active', activated_at = now(), updated_at = now() where id = $1 returning ${COLS}`,
      [id],
    );
    return r.rows[0]!;
  }

  /** Open (unfinished) reports in a sprint, test data included: closing and deleting must see all of them. */
  async openIssues(sprintId: string, q: Q = this.db, lock = false): Promise<{ id: string; ref: string; ref_no: string; status: string }[]> {
    const r = await q.query<{ id: string; ref: string; ref_no: string; status: string }>(
      `select id, ref, ref_no, status from luna_feedback.submissions
        where sprint_id = $1 and status not in ${TERMINAL} order by ref_no${lock ? ' for update' : ''}`,
      [sprintId],
    );
    return r.rows;
  }

  /** Every report in a sprint, test data included, and how many are still open. */
  async countAll(sprintId: string, q: Q = this.db): Promise<{ total: number; open: number }> {
    const r = await q.query<{ total: number; open: number }>(
      `select count(*)::int as total, count(*) filter (where status not in ${TERMINAL})::int as open
         from luna_feedback.submissions where sprint_id = $1`,
      [sprintId],
    );
    return r.rows[0] ?? { total: 0, open: 0 };
  }

  /** Moves one report and writes the history line, inside the caller's transaction. Not a team response (no touch). */
  async moveIssue(submissionId: string, toSprintId: string | null, e: { actor: string | null; from: string | null; to: string | null; note: string | null }, q: Q): Promise<void> {
    await q.query(`update luna_feedback.submissions set sprint_id = $2 where id = $1`, [submissionId, toSprintId]);
    await q.query(
      `insert into luna_feedback.submission_events (submission_id, actor, action, from_value, to_value, note)
       values ($1, $2, 'sprint', $3, $4, $5)`,
      [submissionId, e.actor, e.from, e.to, e.note],
    );
  }

  /** Deletes the reports in a sprint (their history, diagnoses and links cascade) and the sprint. Returns the screenshots to clean up. */
  async deleteWithIssues(sprintId: string, q: Q): Promise<{ deleted: number; screenshots: Screenshot[] }> {
    const subs = await q.query<{ screenshots: Screenshot[] }>(
      `delete from luna_feedback.submissions where sprint_id = $1 returning screenshots`,
      [sprintId],
    );
    await q.query(`delete from luna_feedback.sprints where id = $1`, [sprintId]);
    return { deleted: subs.rowCount ?? 0, screenshots: subs.rows.flatMap((x) => x.screenshots ?? []) };
  }

  /** Counts for every sprint (or the ones given), real issues only. */
  async counts(ids?: string[]): Promise<Map<string, SprintCounts>> {
    const filter = ids ? 'where sp.id = any($1::uuid[])' : '';
    const vals = ids ? [ids] : [];
    const [main, carried] = await Promise.all([
      this.db.query<{ id: string; issues: number; open: number; p0_open: number; p1_open: number; unassigned_open: number; open_with_test: number; by_status: Record<string, number> | null }>(
        `select sp.id,
                count(s.id)::int as issues,
                count(s.id) filter (where s.status not in ${TERMINAL})::int as open,
                count(s.id) filter (where s.status not in ${TERMINAL} and s.priority = 'p0')::int as p0_open,
                count(s.id) filter (where s.status not in ${TERMINAL} and s.priority = 'p1')::int as p1_open,
                count(s.id) filter (where s.status not in ${TERMINAL} and s.assigned_to is null)::int as unassigned_open,
                (select count(*) from luna_feedback.submissions s3 where s3.sprint_id = sp.id and s3.status not in ${TERMINAL})::int as open_with_test,
                (select json_object_agg(x.status, x.n) from (
                   select s2.status, count(*)::int as n from luna_feedback.submissions s2
                    where s2.sprint_id = sp.id and not s2.is_test group by s2.status) x) as by_status
           from luna_feedback.sprints sp
           left join luna_feedback.submissions s on s.sprint_id = sp.id and not s.is_test
           ${filter}
          group by sp.id`,
        vals,
      ),
      this.db.query<{ ref: string; dir: 'in' | 'out'; n: number }>(
        `select e.to_value as ref, 'in' as dir, count(distinct e.submission_id)::int as n
           from luna_feedback.submission_events e join luna_feedback.submissions s on s.id = e.submission_id and not s.is_test
          where e.action = 'sprint' and e.note like '${CARRIED_NOTE}%' and e.to_value is not null
          group by e.to_value
         union all
         select e.from_value as ref, 'out' as dir, count(distinct e.submission_id)::int as n
           from luna_feedback.submission_events e join luna_feedback.submissions s on s.id = e.submission_id and not s.is_test
          where e.action = 'sprint' and e.note like '${CARRIED_NOTE}%' and e.from_value is not null
          group by e.from_value`,
      ),
    ]);
    const refs = new Map((await this.db.query<{ id: string; ref: string }>(`select id, ref from luna_feedback.sprints`)).rows.map((r) => [r.ref, r.id]));
    const out = new Map<string, SprintCounts>();
    for (const r of main.rows) {
      out.set(r.id, { ...EMPTY_COUNTS(), issues: r.issues, open: r.open, done: r.issues - r.open, by_status: r.by_status ?? {}, p0_open: r.p0_open, p1_open: r.p1_open, unassigned_open: r.unassigned_open, open_with_test: r.open_with_test });
    }
    for (const c of carried.rows) {
      const id = refs.get(c.ref); const row = id ? out.get(id) : undefined;
      if (!row) continue;
      if (c.dir === 'in') row.carried_in = c.n; else row.carried_out = c.n;
    }
    return out;
  }

  /** One sprint's real issues by feature, open and done. */
  async byFeature(sprintId: string): Promise<{ feature_key: string; open: number; done: number }[]> {
    const r = await this.db.query<{ feature_key: string; open: number; done: number }>(
      `select s.feature_key,
              count(*) filter (where s.status not in ${TERMINAL})::int as open,
              count(*) filter (where s.status in ${TERMINAL})::int as done
         from luna_feedback.submissions s
        where s.sprint_id = $1 and not s.is_test
        group by s.feature_key
        order by count(*) filter (where s.status not in ${TERMINAL}) desc, count(*) desc, s.feature_key`,
      [sprintId],
    );
    return r.rows;
  }

  /**
   * Real issues filed into the sprint on each of its days (received, in the app's time zone).
   * Issues carried in from the sprint before are left out: they were filed then, not now.
   */
  async perDay(sprint: SprintRow): Promise<{ date: string; count: number }[]> {
    const r = await this.db.query<{ date: string; count: number }>(
      `select (s.created_at at time zone $2)::date::text as date, count(*)::int as count
         from luna_feedback.submissions s
        where s.sprint_id = $1 and not s.is_test
          and (s.created_at at time zone $2)::date between $3::date and $4::date
          and not exists (select 1 from luna_feedback.submission_events e
                           where e.submission_id = s.id and e.action = 'sprint' and e.to_value = $5 and e.note like '${CARRIED_NOTE}%')
        group by 1 order by 1`,
      [sprint.id, this.timeZone, sprint.starts_on, sprint.ends_on, sprint.ref],
    );
    return r.rows;
  }

  /** Open real issues in a sprint assigned to this person. */
  async mineOpen(sprintId: string, email: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `select count(*)::int as n from luna_feedback.submissions
        where sprint_id = $1 and not is_test and assigned_to = $2 and status not in ${TERMINAL}`,
      [sprintId, email],
    );
    return r.rows[0]?.n ?? 0;
  }
}
