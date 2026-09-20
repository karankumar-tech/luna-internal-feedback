import type { Db } from '../../db/pool.js';

export interface Screenshot {
  file_id: string;
  url: string;
  thumbnail_url?: string | null;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  size?: number | null;
  upload_size?: number | null;
  original_width?: number | null;
  original_height?: number | null;
}

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
  screenshots: Screenshot[];
  environment: string;
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
  status: string;
  status_note: string | null;
  status_changed_at: Date | null;
  status_changed_by: string | null;
  jira_key: string | null;
  jira_url: string | null;
  jira_status: string | null;
  jira_synced_at: Date | null;
  jira_created_by: string | null;
  ai_status: string | null;
  ai_side: string | null;
  ai_severity: string | null;
  ai_event_codes: string[];
  ai_checked_at: Date | null;
}

/** Where a ticket sits in triage. QC owns the transitions; everyone else reads them. */
export const SUBMISSION_STATUSES = ['open', 'triaged', 'in_progress', 'resolved', 'closed', 'wont_fix'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

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
  screenshots: Screenshot[];
  client: Partial<Record<'environment' | 'platform' | 'app_version' | 'build_number' | 'build_channel' | 'firmware_version' | 'os_version' | 'device_id' | 'session_id', string | null>>;
  idempotency_key: string | null;
  schema_version: number;
  is_test: boolean;
}

/** Filters every list/stats/analytics query shares, so numbers on one screen always agree. */
export interface CommonFilters {
  feature?: string;
  environment?: string;
  platform?: string;
  is_test?: boolean;
  status?: string;
  /** 'any' = linked to some Jira ticket, 'none' = not linked. */
  jira?: 'any' | 'none';
  ai_status?: string;
  ai_side?: string;
  ai_severity?: string;
  ai_tag?: string;
  event_code?: string;
  kind_id?: string;
  user_id?: number;
  is_positive?: boolean;
  category?: string;
}

export interface ListFilters extends CommonFilters {
  from?: string;
  to?: string;
  limit: number;
  /** Opaque cursor: `${created_at ISO}|${id}` of the last row seen. */
  cursor?: string;
}

export interface StatsFilters extends CommonFilters {
  from: string;
  to: string;
}

export interface StatsResult {
  range: { from: string; to: string };
  totals: { submissions: number; positive: number; negative: number; users: number };
  by_day: { date: string; positive: number; negative: number }[];
  by_feature: { feature_key: string; label: string; positive: number; negative: number }[];
  by_category: { feature_key: string; key: string; label: string; count: number }[];
  by_environment: { environment: string; positive: number; negative: number }[];
  by_status: { status: string; count: number }[];
  jira: { linked: number; unlinked: number };
  top_kinds: { id: string; key: string; title: string; count: number }[];
  diagnosis: {
    checked: number;          // done or no_logs
    with_verdict: number;     // done
    waiting: number;          // pending/running/waiting_logs
    failed: number;
    logs_found: number;       // done (logs existed)
    by_side: { feature_key: string; side: string; count: number }[];
    by_severity: { severity: string; count: number }[];
    top_tags: { tag: string; count: number }[];
  };
}

export function buildWhere(f: Partial<StatsFilters>, alias = 's'): { where: string; vals: unknown[] } {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { if (v === undefined) { where.push(sql); return; } vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (f.feature) add(`${alias}.feature_key = ?`, f.feature);
  if (f.environment) add(`${alias}.environment = ?`, f.environment);
  if (f.platform) add(`${alias}.platform = ?`, f.platform);
  if (f.is_test !== undefined) add(`${alias}.is_test = ?`, f.is_test);
  if (f.status) add(`${alias}.status = ?`, f.status);
  if (f.jira === 'any') add(`${alias}.jira_key is not null`, undefined);
  if (f.jira === 'none') add(`${alias}.jira_key is null`, undefined);
  if (f.ai_status) add(f.ai_status === 'none' ? `${alias}.ai_status is null` : `${alias}.ai_status = ?`, f.ai_status === 'none' ? undefined : f.ai_status);
  if (f.ai_side) add(`${alias}.ai_side = ?`, f.ai_side);
  if (f.ai_severity) add(`${alias}.ai_severity = ?`, f.ai_severity);
  if (f.event_code) add(`? = any(${alias}.ai_event_codes)`, f.event_code);
  if (f.ai_tag) add(`exists (select 1 from luna_feedback.diagnoses dt where dt.submission_id = ${alias}.id and ? = any(dt.tags))`, f.ai_tag);
  if (f.kind_id) add(`exists (select 1 from luna_feedback.submission_issue_kinds sk where sk.submission_id = ${alias}.id and sk.kind_id = ?::uuid)`, f.kind_id);
  if (f.user_id !== undefined) add(`${alias}.user_id = ?`, f.user_id);
  if (f.from) add(`${alias}.occurred_on >= ?`, f.from);
  if (f.to) add(`${alias}.occurred_on <= ?`, f.to);
  if (f.is_positive !== undefined) add(`${alias}.is_positive = ?`, f.is_positive);
  if (f.category) add(`? = any(${alias}.issue_categories)`, f.category);
  return { where: where.length ? 'where ' + where.join(' and ') : '', vals };
}

const COLUMNS = `id, feature_key, is_positive, occurred_on::text as occurred_on, user_id, email, issue_categories,
  created_at, feedback_text, device_serial, details, screenshots, environment, platform, app_version, build_number, build_channel, firmware_version, os_version,
  device_id, session_id, idempotency_key, schema_version, is_test, status, status_note, status_changed_at, status_changed_by,
  jira_key, jira_url, jira_status, jira_synced_at, jira_created_by, ai_status, ai_side, ai_severity, ai_event_codes, ai_checked_at`;

export class FeedbackRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts one submission. If idempotency_key collides, returns the existing row and `created: false`.
   */
  async insert(s: NewSubmission): Promise<{ row: SubmissionRow; created: boolean }> {
    const params = [
      s.feature_key, s.is_positive, s.occurred_on, s.user_id, s.email, s.issue_categories, s.feedback_text, s.device_serial,
      JSON.stringify(s.details), JSON.stringify(s.screenshots),
      s.client.environment ?? null,
      s.client.platform ?? null, s.client.app_version ?? null, s.client.build_number ?? null, s.client.build_channel ?? null,
      s.client.firmware_version ?? null, s.client.os_version ?? null, s.client.device_id ?? null,
      s.client.session_id ?? null, s.idempotency_key, s.schema_version, s.is_test,
    ];
    const inserted = await this.db.query<SubmissionRow>(
      `insert into luna_feedback.submissions
         (feature_key, is_positive, occurred_on, user_id, email, issue_categories, feedback_text, device_serial, details, screenshots,
          environment, platform, app_version, build_number, build_channel, firmware_version, os_version, device_id, session_id,
          idempotency_key, schema_version, is_test)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,coalesce($11, 'stage'),$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
  async deleteTestData(): Promise<{ deleted: number; screenshotFileIds: string[] }> {
    const r = await this.db.query<{ screenshots: Screenshot[] }>('delete from luna_feedback.submissions where is_test returning screenshots');
    const ids = r.rows.flatMap((row) => (row.screenshots ?? []).map((x) => x.file_id)).filter(Boolean);
    return { deleted: r.rowCount ?? 0, screenshotFileIds: ids };
  }

  async countTestData(): Promise<number> {
    const r = await this.db.query<{ n: number }>('select count(*)::int as n from luna_feedback.submissions where is_test');
    return r.rows[0]!.n;
  }

  /** Flip the test-data flag on one submission. Returns the updated row, or undefined when the id is unknown. */
  async setTestFlag(id: string, isTest: boolean): Promise<SubmissionRow | undefined> {
    const r = await this.db.query<SubmissionRow>(
      `update luna_feedback.submissions set is_test = $2 where id = $1 returning ${COLUMNS}`,
      [id, isTest],
    );
    return r.rows[0];
  }

  /** Moves a ticket through triage. `by` is the dashboard user who did it, for the audit trail. */
  async setStatus(id: string, status: SubmissionStatus, note: string | null, by: string | null): Promise<SubmissionRow | undefined> {
    const r = await this.db.query<SubmissionRow>(
      `update luna_feedback.submissions
          set status = $2, status_note = $3, status_changed_by = $4, status_changed_at = now()
        where id = $1 returning ${COLUMNS}`,
      [id, status, note, by],
    );
    return r.rows[0];
  }

  /** Records the Jira ticket created for this submission. */
  async setJira(id: string, jira: { key: string; url: string; status: string | null; by: string | null }): Promise<SubmissionRow | undefined> {
    const r = await this.db.query<SubmissionRow>(
      `update luna_feedback.submissions
          set jira_key = $2, jira_url = $3, jira_status = $4, jira_created_by = coalesce(jira_created_by, $5), jira_synced_at = now()
        where id = $1 returning ${COLUMNS}`,
      [id, jira.key, jira.url, jira.status, jira.by],
    );
    return r.rows[0];
  }

  /** Refreshes the cached Jira workflow status without touching who created it. */
  async setJiraStatus(id: string, status: string | null): Promise<void> {
    await this.db.query(
      `update luna_feedback.submissions set jira_status = $2, jira_synced_at = now() where id = $1`,
      [id, status],
    );
  }

  /** Submissions with a Jira ticket whose cached status is stale, oldest first. */
  async jiraStale(limit: number, olderThanMinutes: number): Promise<{ id: string; jira_key: string }[]> {
    const r = await this.db.query<{ id: string; jira_key: string }>(
      `select id, jira_key from luna_feedback.submissions
        where jira_key is not null and (jira_synced_at is null or jira_synced_at < now() - ($2::int * interval '1 minute'))
        order by jira_synced_at asc nulls first limit $1`,
      [limit, olderThanMinutes],
    );
    return r.rows;
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

    const [totals, byDay, byFeature, byCategory, byEnvironment, byStatus, jira, topKinds, diagTotals, bySide, bySeverity, topTags] = await Promise.all([
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
      this.db.query<{ environment: string; positive: number; negative: number }>(
        `select s.environment,
                count(*) filter (where s.is_positive)::int as positive,
                count(*) filter (where not s.is_positive)::int as negative
         ${base} group by s.environment order by s.environment`, vals),
      this.db.query<{ status: string; count: number }>(
        `select s.status, count(*)::int as count ${base} group by s.status order by count desc`, vals),
      this.db.query<{ linked: number; unlinked: number }>(
        `select count(*) filter (where s.jira_key is not null)::int as linked,
                count(*) filter (where s.jira_key is null)::int as unlinked
         ${base}`, vals),
      this.db.query<{ id: string; key: string; title: string; count: number }>(
        `select k.id, k.key, k.title, count(*)::int as count
         from luna_feedback.submissions s
         join luna_feedback.submission_issue_kinds sk on sk.submission_id = s.id
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
         ${where} group by k.id, k.key, k.title order by count desc limit 10`, vals),
      this.db.query<{ checked: number; with_verdict: number; waiting: number; failed: number }>(
        `select count(*) filter (where s.ai_status in ('done','no_logs'))::int as checked,
                count(*) filter (where s.ai_status = 'done')::int as with_verdict,
                count(*) filter (where s.ai_status in ('pending','running','waiting_logs'))::int as waiting,
                count(*) filter (where s.ai_status = 'failed')::int as failed
         ${base}`, vals),
      this.db.query<{ feature_key: string; side: string; count: number }>(
        `select s.feature_key, s.ai_side as side, count(*)::int as count ${base} ${where ? 'and' : 'where'} s.ai_side is not null
         group by s.feature_key, s.ai_side order by count desc`, vals),
      this.db.query<{ severity: string; count: number }>(
        `select s.ai_severity as severity, count(*)::int as count ${base} ${where ? 'and' : 'where'} s.ai_severity is not null
         group by s.ai_severity order by count desc`, vals),
      this.db.query<{ tag: string; count: number }>(
        `select t.tag, count(*)::int as count
         from luna_feedback.submissions s
         join luna_feedback.diagnoses d on d.submission_id = s.id
         cross join lateral unnest(d.tags) as t(tag)
         ${where} group by t.tag order by count desc limit 12`, vals),
    ]);

    return {
      range: { from: f.from, to: f.to },
      totals: totals.rows[0]!,
      by_day: byDay.rows,
      by_feature: byFeature.rows,
      by_category: byCategory.rows,
      by_environment: byEnvironment.rows,
      by_status: byStatus.rows,
      jira: jira.rows[0] ?? { linked: 0, unlinked: 0 },
      top_kinds: topKinds.rows,
      diagnosis: {
        checked: diagTotals.rows[0]?.checked ?? 0,
        with_verdict: diagTotals.rows[0]?.with_verdict ?? 0,
        waiting: diagTotals.rows[0]?.waiting ?? 0,
        failed: diagTotals.rows[0]?.failed ?? 0,
        logs_found: diagTotals.rows[0]?.with_verdict ?? 0,
        by_side: bySide.rows,
        by_severity: bySeverity.rows,
        top_tags: topTags.rows,
      },
    };
  }
}
