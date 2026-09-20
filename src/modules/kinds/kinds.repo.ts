import type { Db } from '../../db/pool.js';
import { buildWhere, type CommonFilters } from '../feedback/feedback.repo.js';

export const KIND_STATUSES = ['open', 'watching', 'fixed', 'wont_fix'] as const;
export type KindStatus = (typeof KIND_STATUSES)[number];

export const KIND_LINK_SOURCES = ['manual', 'ai', 'rule'] as const;
export type KindLinkSource = (typeof KIND_LINK_SOURCES)[number];

export interface IssueKindRow {
  id: string;
  key: string;
  title: string;
  description: string | null;
  feature_key: string | null;
  tags: string[];
  event_codes: string[];
  status: string;
  severity: string | null;
  jira_key: string | null;
  jira_url: string | null;
  is_archived: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A kind plus how much of it is actually happening in the window being looked at. */
export interface IssueKindWithCounts extends IssueKindRow {
  count: number;
  users: number;
  first_seen: string | null;
  last_seen: string | null;
  open_count: number;
  /** Instances in the window that the model linked rather than a person. */
  ai_count: number;
}

export interface KindLink {
  kind_id: string;
  key: string;
  title: string;
  status: string;
  severity: string | null;
  jira_key: string | null;
  jira_url: string | null;
  source: string;
  confidence: number | null;
  created_by: string | null;
  created_at: Date;
}

const K_COLS = `k.id, k.key, k.title, k.description, k.feature_key, k.tags, k.event_codes, k.status, k.severity,
  k.jira_key, k.jira_url, k.is_archived, k.created_by, k.created_at, k.updated_at`;

/** "Sleep start recorded hours late" -> "sleep_start_recorded_hours_late". */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/, '');
  // The column requires a leading letter.
  return /^[a-z]/.test(base) ? base : `kind_${base}`.slice(0, 60).replace(/_+$/, '');
}

/** Comparison form for "is this the same kind?": case, spacing and punctuation removed. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class KindsRepo {
  constructor(private readonly db: Db) {}

  async byId(id: string): Promise<IssueKindRow | undefined> {
    const r = await this.db.query<IssueKindRow>(`select ${K_COLS} from luna_feedback.issue_kinds k where k.id = $1`, [id]);
    return r.rows[0];
  }

  async byKey(key: string): Promise<IssueKindRow | undefined> {
    const r = await this.db.query<IssueKindRow>(`select ${K_COLS} from luna_feedback.issue_kinds k where k.key = $1`, [key]);
    return r.rows[0];
  }

  /** Every kind with a normalized title, for matching a model suggestion against what exists. */
  async titles(): Promise<{ id: string; key: string; title: string }[]> {
    const r = await this.db.query<{ id: string; key: string; title: string }>(
      `select id, key, title from luna_feedback.issue_kinds where not is_archived order by updated_at desc`,
    );
    return r.rows;
  }

  /**
   * Kinds with their instance counts inside the filtered window.
   * The filters are the dashboard's own, so a kind's count always matches the ticket list behind it.
   */
  async list(filters: Partial<CommonFilters> & { from?: string; to?: string; includeArchived?: boolean; status?: string }): Promise<IssueKindWithCounts[]> {
    // `status` on this endpoint means the kind's status, not the submission's.
    const { status: kindStatus, ...submissionFilters } = filters;
    const { where, vals } = buildWhere(submissionFilters);
    const params: unknown[] = [...vals];
    const conds: string[] = [];
    if (!filters.includeArchived) conds.push('not k.is_archived');
    if (kindStatus) { params.push(kindStatus); conds.push(`k.status = $${params.length}`); }

    const r = await this.db.query<IssueKindWithCounts>(
      `select ${K_COLS},
              coalesce(c.count, 0)::int       as count,
              coalesce(c.users, 0)::int       as users,
              c.first_seen::text              as first_seen,
              c.last_seen::text               as last_seen,
              coalesce(c.open_count, 0)::int  as open_count,
              coalesce(c.ai_count, 0)::int    as ai_count
         from luna_feedback.issue_kinds k
         left join (
           select sk.kind_id,
                  count(*)::int as count,
                  count(distinct s.user_id)::int as users,
                  min(s.occurred_on) as first_seen,
                  max(s.occurred_on) as last_seen,
                  count(*) filter (where s.status not in ('closed','resolved','wont_fix'))::int as open_count,
                  count(*) filter (where sk.source = 'ai')::int as ai_count
             from luna_feedback.submission_issue_kinds sk
             join luna_feedback.submissions s on s.id = sk.submission_id
             ${where}
            group by sk.kind_id
         ) c on c.kind_id = k.id
        ${conds.length ? 'where ' + conds.join(' and ') : ''}
        order by coalesce(c.count, 0) desc, k.updated_at desc`,
      params,
    );
    return r.rows;
  }

  /** Day-by-day instances of one kind, for the "is this getting worse?" chart. */
  async trend(kindId: string, filters: Partial<CommonFilters> & { from?: string; to?: string }): Promise<{ date: string; count: number }[]> {
    const { where, vals } = buildWhere(filters);
    const params = [...vals, kindId];
    const r = await this.db.query<{ date: string; count: number }>(
      `select s.occurred_on::text as date, count(*)::int as count
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.submissions s on s.id = sk.submission_id
        ${where ? where + ' and' : 'where'} sk.kind_id = $${params.length}::uuid
        group by s.occurred_on order by s.occurred_on`,
      params,
    );
    return r.rows;
  }

  async create(k: {
    key: string; title: string; description: string | null; feature_key: string | null;
    tags: string[]; event_codes: string[]; severity: string | null; status?: KindStatus; created_by: string | null;
  }): Promise<IssueKindRow> {
    const r = await this.db.query<IssueKindRow>(
      `insert into luna_feedback.issue_kinds (key, title, description, feature_key, tags, event_codes, severity, status, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'open'),$9)
       returning ${K_COLS.replace(/k\./g, '')}`,
      [k.key, k.title, k.description, k.feature_key, k.tags, k.event_codes, k.severity, k.status ?? null, k.created_by],
    );
    return r.rows[0]!;
  }

  async update(id: string, patch: Partial<Pick<IssueKindRow, 'title' | 'description' | 'feature_key' | 'tags' | 'event_codes' | 'status' | 'severity' | 'is_archived' | 'jira_key' | 'jira_url'>>): Promise<IssueKindRow | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [col, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      vals.push(value);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return this.byId(id);
    const r = await this.db.query<IssueKindRow>(
      `update luna_feedback.issue_kinds set ${sets.join(', ')} where id = $1 returning ${K_COLS.replace(/k\./g, '')}`,
      vals,
    );
    return r.rows[0];
  }

  async link(submissionId: string, kindId: string, source: KindLinkSource, confidence: number | null, by: string | null): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.submission_issue_kinds (submission_id, kind_id, source, confidence, created_by)
       values ($1,$2,$3,$4,$5)
       on conflict (submission_id, kind_id) do update
         set source = case when luna_feedback.submission_issue_kinds.source = 'ai' then excluded.source
                           else luna_feedback.submission_issue_kinds.source end,
             confidence = coalesce(excluded.confidence, luna_feedback.submission_issue_kinds.confidence)`,
      [submissionId, kindId, source, confidence, by],
    );
  }

  async unlink(submissionId: string, kindId: string): Promise<boolean> {
    const r = await this.db.query(
      `delete from luna_feedback.submission_issue_kinds where submission_id = $1 and kind_id = $2`,
      [submissionId, kindId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async forSubmission(submissionId: string): Promise<KindLink[]> {
    const r = await this.db.query<KindLink>(
      `select k.id as kind_id, k.key, k.title, k.status, k.severity, k.jira_key, k.jira_url,
              sk.source, sk.confidence::float8 as confidence, sk.created_by, sk.created_at
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
        where sk.submission_id = $1
        order by sk.created_at`,
      [submissionId],
    );
    return r.rows;
  }

  /** Kind links for many submissions at once, so a list page does not fan out one query per row. */
  async forSubmissions(ids: string[]): Promise<Map<string, { id: string; key: string; title: string }[]>> {
    const out = new Map<string, { id: string; key: string; title: string }[]>();
    if (!ids.length) return out;
    const r = await this.db.query<{ submission_id: string; id: string; key: string; title: string }>(
      `select sk.submission_id, k.id, k.key, k.title
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
        where sk.submission_id = any($1::uuid[])`,
      [ids],
    );
    for (const row of r.rows) {
      const list = out.get(row.submission_id) ?? [];
      list.push({ id: row.id, key: row.key, title: row.title });
      out.set(row.submission_id, list);
    }
    return out;
  }
}
