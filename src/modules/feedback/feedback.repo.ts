import type { Db } from '../../db/pool.js';

export interface SubmissionRow {
  id: string;
  feature_key: string;
  is_positive: boolean;
  occurred_on: string;
  user_id: string; // bigint comes back as string from pg
  email: string;
  issue_categories: string[];
  created_at: Date;
  feedback_text: string | null;
  device_serial: string | null;
  details: Record<string, unknown>;
  platform: string | null;
  app_version: string | null;
  build_number: string | null;
  build_channel: string | null;
  firmware_version: string | null;
  os_version: string | null;
  device_id: string | null;
  session_id: string | null;
  idempotency_key: string | null;
  schema_version: number;
  is_test: boolean;
}

export interface NewSubmission {
  feature_key: string;
  is_positive: boolean;
  occurred_on: string;
  user_id: number;
  email: string;
  issue_categories: string[];
  feedback_text: string | null;
  device_serial: string | null;
  details: Record<string, unknown>;
  client: Partial<Record<'platform' | 'app_version' | 'build_number' | 'build_channel' | 'firmware_version' | 'os_version' | 'device_id' | 'session_id', string | null>>;
  idempotency_key: string | null;
  schema_version: number;
  is_test: boolean;
}

export interface ListFilters {
  feature?: string;
  platform?: string;
  is_test?: boolean;
  user_id?: number;
  from?: string;
  to?: string;
  is_positive?: boolean;
  category?: string;
  limit: number;
  /** Opaque cursor: `${created_at ISO}|${id}` of the last row seen. */
  cursor?: string;
}

export interface StatsFilters {
  feature?: string;
  platform?: string;
  is_test?: boolean;
  user_id?: number;
  from: string;
  to: string;
  is_positive?: boolean;
  category?: string;
}

export interface StatsResult {
  range: { from: string; to: string };
  totals: { submissions: number; positive: number; negative: number; users: number };
  by_day: { date: string; positive: number; negative: number }[];
  by_feature: { feature_key: string; label: string; positive: number; negative: number }[];
  by_category: { feature_key: string; key: string; label: string; count: number }[];
}

function buildWhere(f: Partial<StatsFilters>, alias = 's'): { where: string; vals: unknown[] } {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (f.feature) add(`${alias}.feature_key = ?`, f.feature);
  if (f.platform) add(`${alias}.platform = ?`, f.platform);
  if (f.is_test !== undefined) add(`${alias}.is_test = ?`, f.is_test);
  if (f.user_id !== undefined) add(`${alias}.user_id = ?`, f.user_id);
  if (f.from) add(`${alias}.occurred_on >= ?`, f.from);
  if (f.to) add(`${alias}.occurred_on <= ?`, f.to);
  if (f.is_positive !== undefined) add(`${alias}.is_positive = ?`, f.is_positive);
  if (f.category) add(`? = any(${alias}.issue_categories)`, f.category);
  return { where: where.length ? 'where ' + where.join(' and ') : '', vals };
}

const COLUMNS = `id, feature_key, is_positive, occurred_on::text as occurred_on, user_id, email, issue_categories,
  created_at, feedback_text, device_serial, details, platform, app_version, build_number, build_channel, firmware_version, os_version,
  device_id, session_id, idempotency_key, schema_version, is_test`;

export class FeedbackRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts one submission. If idempotency_key collides, returns the existing row and `created: false`.
   */
  async insert(s: NewSubmission): Promise<{ row: SubmissionRow; created: boolean }> {
    const params = [
      s.feature_key, s.is_positive, s.occurred_on, s.user_id, s.email, s.issue_categories, s.feedback_text, s.device_serial,
      JSON.stringify(s.details),
      s.client.platform ?? null, s.client.app_version ?? null, s.client.build_number ?? null, s.client.build_channel ?? null,
      s.client.firmware_version ?? null, s.client.os_version ?? null, s.client.device_id ?? null,
      s.client.session_id ?? null, s.idempotency_key, s.schema_version, s.is_test,
    ];
    const inserted = await this.db.query<SubmissionRow>(
      `insert into luna_feedback.submissions
         (feature_key, is_positive, occurred_on, user_id, email, issue_categories, feedback_text, device_serial, details,
          platform, app_version, build_number, build_channel, firmware_version, os_version, device_id, session_id,
          idempotency_key, schema_version, is_test)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning ${COLUMNS}`,
      params,
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };

    const existing = await this.db.query<SubmissionRow>(
      `select ${COLUMNS} from luna_feedback.submissions where idempotency_key = $1`,
      [s.idempotency_key],
    );
    return { row: existing.rows[0]!, created: false };
  }

  /** Deletes every submission flagged as test data. Real rows are never touched. */
  async deleteTestData(): Promise<number> {
    const r = await this.db.query('delete from luna_feedback.submissions where is_test');
    return r.rowCount ?? 0;
  }

  async countTestData(): Promise<number> {
    const r = await this.db.query<{ n: number }>('select count(*)::int as n from luna_feedback.submissions where is_test');
    return r.rows[0]!.n;
  }

  async byId(id: string): Promise<SubmissionRow | undefined> {
    const r = await this.db.query<SubmissionRow>(`select ${COLUMNS} from luna_feedback.submissions where id = $1`, [id]);
    return r.rows[0];
  }

  async list(f: ListFilters): Promise<{ rows: SubmissionRow[]; nextCursor: string | null }> {
    const built = buildWhere(f);
    const clauses = built.where ? [built.where.replace(/^where /, '')] : [];
    const vals = built.vals;
    if (f.cursor) {
      const [ts, id] = f.cursor.split('|');
      vals.push(ts, id);
      clauses.push(`(s.created_at, s.id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`);
    }
    vals.push(f.limit + 1);

    const r = await this.db.query<SubmissionRow>(
      `select ${COLUMNS} from luna_feedback.submissions s
       ${clauses.length ? 'where ' + clauses.join(' and ') : ''}
       order by s.created_at desc, s.id desc
       limit $${vals.length}`,
      vals,
    );
    const rows = r.rows.slice(0, f.limit);
    const last = rows[rows.length - 1];
    const nextCursor = r.rows.length > f.limit && last ? `${last.created_at.toISOString()}|${last.id}` : null;
    return { rows, nextCursor };
  }

  /** Aggregates for the dashboard. All queries share the same filter slice so numbers agree. */
  async stats(f: StatsFilters): Promise<StatsResult> {
    const { where, vals } = buildWhere(f);
    const base = `from luna_feedback.submissions s ${where}`;

    const [totals, byDay, byFeature, byCategory] = await Promise.all([
      this.db.query<{ submissions: number; positive: number; negative: number; users: number }>(
        `select count(*)::int as submissions,
                count(*) filter (where s.is_positive)::int as positive,
                count(*) filter (where not s.is_positive)::int as negative,
                count(distinct s.user_id)::int as users
         ${base}`, vals),
      this.db.query<{ date: string; positive: number; negative: number }>(
        `select s.occurred_on::text as date,
                count(*) filter (where s.is_positive)::int as positive,
                count(*) filter (where not s.is_positive)::int as negative
         ${base} group by s.occurred_on order by s.occurred_on`, vals),
      this.db.query<{ feature_key: string; label: string; positive: number; negative: number }>(
        `select f.key as feature_key, f.label,
                coalesce(count(s.id) filter (where s.is_positive), 0)::int as positive,
                coalesce(count(s.id) filter (where not s.is_positive), 0)::int as negative
         from luna_feedback.features f
         left join luna_feedback.submissions s on s.feature_key = f.key ${where ? 'and ' + where.replace(/^where /, '') : ''}
         where f.is_active
         group by f.key, f.label, f.sort_order order by f.sort_order`, vals),
      this.db.query<{ feature_key: string; key: string; label: string; count: number }>(
        `select s.feature_key, c.key, coalesce(ic.label, c.key) as label, count(*)::int as count
         from luna_feedback.submissions s
         cross join lateral unnest(s.issue_categories) as c(key)
         left join luna_feedback.issue_categories ic on ic.feature_key = s.feature_key and ic.key = c.key
         ${where}
         group by s.feature_key, c.key, ic.label
         order by count desc, s.feature_key, c.key`, vals),
    ]);

    return {
      range: { from: f.from, to: f.to },
      totals: totals.rows[0]!,
      by_day: byDay.rows,
      by_feature: byFeature.rows,
      by_category: byCategory.rows,
    };
  }
}
