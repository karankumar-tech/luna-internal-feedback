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
  details: Record<string, unknown>;
  app_version: string | null;
  build_number: string | null;
  build_channel: string | null;
  firmware_version: string | null;
  os_version: string | null;
  device_id: string | null;
  session_id: string | null;
  idempotency_key: string | null;
  schema_version: number;
}

export interface NewSubmission {
  feature_key: string;
  is_positive: boolean;
  occurred_on: string;
  user_id: number;
  email: string;
  issue_categories: string[];
  feedback_text: string | null;
  details: Record<string, unknown>;
  client: Partial<Record<'app_version' | 'build_number' | 'build_channel' | 'firmware_version' | 'os_version' | 'device_id' | 'session_id', string | null>>;
  idempotency_key: string | null;
  schema_version: number;
}

export interface ListFilters {
  feature?: string;
  user_id?: number;
  from?: string;
  to?: string;
  is_positive?: boolean;
  category?: string;
  limit: number;
  /** Opaque cursor: `${created_at ISO}|${id}` of the last row seen. */
  cursor?: string;
}

const COLUMNS = `id, feature_key, is_positive, occurred_on::text as occurred_on, user_id, email, issue_categories,
  created_at, feedback_text, details, app_version, build_number, build_channel, firmware_version, os_version,
  device_id, session_id, idempotency_key, schema_version`;

export class FeedbackRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts one submission. If idempotency_key collides, returns the existing row and `created: false`.
   */
  async insert(s: NewSubmission): Promise<{ row: SubmissionRow; created: boolean }> {
    const params = [
      s.feature_key, s.is_positive, s.occurred_on, s.user_id, s.email, s.issue_categories, s.feedback_text,
      JSON.stringify(s.details),
      s.client.app_version ?? null, s.client.build_number ?? null, s.client.build_channel ?? null,
      s.client.firmware_version ?? null, s.client.os_version ?? null, s.client.device_id ?? null,
      s.client.session_id ?? null, s.idempotency_key, s.schema_version,
    ];
    const inserted = await this.db.query<SubmissionRow>(
      `insert into luna_feedback.submissions
         (feature_key, is_positive, occurred_on, user_id, email, issue_categories, feedback_text, details,
          app_version, build_number, build_channel, firmware_version, os_version, device_id, session_id,
          idempotency_key, schema_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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

  async byId(id: string): Promise<SubmissionRow | undefined> {
    const r = await this.db.query<SubmissionRow>(`select ${COLUMNS} from luna_feedback.submissions where id = $1`, [id]);
    return r.rows[0];
  }

  async list(f: ListFilters): Promise<{ rows: SubmissionRow[]; nextCursor: string | null }> {
    const where: string[] = [];
    const vals: unknown[] = [];
    const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };

    if (f.feature) add('feature_key = ?', f.feature);
    if (f.user_id !== undefined) add('user_id = ?', f.user_id);
    if (f.from) add('occurred_on >= ?', f.from);
    if (f.to) add('occurred_on <= ?', f.to);
    if (f.is_positive !== undefined) add('is_positive = ?', f.is_positive);
    if (f.category) add('? = any(issue_categories)', f.category);
    if (f.cursor) {
      const [ts, id] = f.cursor.split('|');
      vals.push(ts, id);
      where.push(`(created_at, id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`);
    }
    vals.push(f.limit + 1);

    const r = await this.db.query<SubmissionRow>(
      `select ${COLUMNS} from luna_feedback.submissions
       ${where.length ? 'where ' + where.join(' and ') : ''}
       order by created_at desc, id desc
       limit $${vals.length}`,
      vals,
    );
    const rows = r.rows.slice(0, f.limit);
    const last = rows[rows.length - 1];
    const nextCursor = r.rows.length > f.limit && last ? `${last.created_at.toISOString()}|${last.id}` : null;
    return { rows, nextCursor };
  }
}
