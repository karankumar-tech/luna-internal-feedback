import type { Db } from '../../db/pool.js';
import { buildWhere, personSql, type CommonFilters } from '../feedback/feedback.repo.js';

export const KIND_STATUSES = ['open', 'watching', 'fixed', 'wont_fix'] as const;
export type KindStatus = (typeof KIND_STATUSES)[number];

export const KIND_LINK_SOURCES = ['manual', 'ai', 'rule'] as const;
export type KindLinkSource = (typeof KIND_LINK_SOURCES)[number];

/**
 * suggested: proposed by a rule at intake or by CX, waiting for a person.
 * linked: a person or a finished diagnosis put it there. Only these count.
 * rejected: a person said "not this". Kept so the same suggestion is never made again.
 */
export const KIND_LINK_STATES = ['suggested', 'linked', 'rejected'] as const;
export type KindLinkState = (typeof KIND_LINK_STATES)[number];

export interface IssueKindRow {
  id: string;
  /** Readable reference, LNK-0007. */
  ref: string;
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
  /** The report to read first for this problem. */
  reference_submission_id: string | null;
  /** Titles of problems merged into this one. */
  aliases: string[];
  /** Set on a problem that was merged away: where its reports went. */
  merged_into: string | null;
  /** Dashboard user (email) who owns the problem. */
  owner: string | null;
  /** The versions the fix ships in. A linked report on one of these or later is a regression. */
  fixed_in_app_version: string | null;
  fixed_in_firmware_version: string | null;
  /** When a report on the fix version or later was last linked. */
  regressed_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** All-time size of a problem among real (or, for test reports, test) reports. */
export interface KindCounts {
  count: number;
  users: number;
  cx_count: number;
  cx_users: number;
  first_seen: string | null;
  last_seen: string | null;
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
  /** Instances that came through CX, and how many customers they are. */
  cx_count: number;
  cx_users: number;
}

export interface KindLink {
  kind_id: string;
  ref: string;
  key: string;
  title: string;
  status: string;
  severity: string | null;
  jira_key: string | null;
  jira_url: string | null;
  source: string;
  state: KindLinkState;
  confidence: number | null;
  created_by: string | null;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  /** The report is on the problem's fix version or later. */
  regression: boolean;
}

/** What a report ran, for comparing against a fix version. The diagnosis's reading of the logs wins over what the app sent. */
export interface ReportVersions {
  id: string;
  ref: string;
  is_test: boolean;
  is_positive: boolean;
  platform: string | null;
  app_version: string | null;
  firmware_version: string | null;
}

/** One value of one dimension (firmware, app, platform, os): how often it appears in a problem vs in all reports. */
export interface SkewRow { dim: 'firmware' | 'app' | 'platform' | 'os'; value: string; kind_count: number; base_count: number }

const K_COLS = `k.id, k.ref, k.key, k.title, k.description, k.feature_key, k.tags, k.event_codes, k.status, k.severity,
  k.jira_key, k.jira_url, k.is_archived, k.reference_submission_id, k.aliases, k.merged_into, k.owner,
  k.fixed_in_app_version, k.fixed_in_firmware_version, k.regressed_at, k.created_by, k.created_at, k.updated_at`;

/** Only confirmed links count toward a problem's size. */
const LINKED = `sk.state = 'linked'`;

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

/** "LNK-0007", "lnk-7", "LNK7" -> 7. A bare number is not accepted: it would be ambiguous with LN- references. */
export function parseKindRef(input: string): number | null {
  const m = /^lnk-?0*(\d{1,12})$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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

  async byRefNo(refNo: number): Promise<IssueKindRow | undefined> {
    const r = await this.db.query<IssueKindRow>(`select ${K_COLS} from luna_feedback.issue_kinds k where k.ref_no = $1`, [refNo]);
    return r.rows[0];
  }

  async byKey(key: string): Promise<IssueKindRow | undefined> {
    const r = await this.db.query<IssueKindRow>(`select ${K_COLS} from luna_feedback.issue_kinds k where k.key = $1`, [key]);
    return r.rows[0];
  }

  /** Every live kind's title and the titles merged into it, for matching a model suggestion against what exists. */
  async titles(): Promise<{ id: string; key: string; title: string; aliases: string[] }[]> {
    const r = await this.db.query<{ id: string; key: string; title: string; aliases: string[] }>(
      `select id, key, title, aliases from luna_feedback.issue_kinds where not is_archived order by updated_at desc`,
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
              coalesce(c.ai_count, 0)::int    as ai_count,
              coalesce(c.cx_count, 0)::int    as cx_count,
              coalesce(c.cx_users, 0)::int    as cx_users
         from luna_feedback.issue_kinds k
         left join (
           select sk.kind_id,
                  count(*)::int as count,
                  count(distinct ${personSql()})::int as users,
                  min(s.occurred_on) as first_seen,
                  max(s.occurred_on) as last_seen,
                  count(*) filter (where s.status not in ('closed','resolved','wont_fix'))::int as open_count,
                  count(*) filter (where sk.source = 'ai')::int as ai_count,
                  count(*) filter (where s.origin = 'cx')::int as cx_count,
                  count(distinct ${personSql()}) filter (where s.origin = 'cx')::int as cx_users
             from luna_feedback.submission_issue_kinds sk
             join luna_feedback.submissions s on s.id = sk.submission_id
             ${where ? where + ' and' : 'where'} ${LINKED}
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
        ${where ? where + ' and' : 'where'} sk.kind_id = $${params.length}::uuid and ${LINKED}
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

  async update(id: string, patch: Partial<Pick<IssueKindRow, 'title' | 'description' | 'feature_key' | 'tags' | 'event_codes' | 'status' | 'severity' | 'is_archived' | 'jira_key' | 'jira_url' | 'reference_submission_id' | 'owner' | 'fixed_in_app_version' | 'fixed_in_firmware_version'>>): Promise<IssueKindRow | undefined> {
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

  /**
   * Records a link decision. A person's decision always stands; a machine never overrides a
   * rejection, and a suggestion never demotes a link that is already confirmed.
   */
  async link(submissionId: string, kindId: string, source: KindLinkSource, confidence: number | null, by: string | null, state: KindLinkState = 'linked'): Promise<void> {
    const decided = source === 'manual' && state !== 'suggested';
    await this.db.query(
      `insert into luna_feedback.submission_issue_kinds as sik (submission_id, kind_id, source, confidence, created_by, state, decided_by, decided_at)
       values ($1, $2, $3, $4, $5, $6, case when $7 then $5 end, case when $7 then now() end)
       on conflict (submission_id, kind_id) do update
         set state = case
                       when excluded.state = 'rejected' then 'rejected'
                       when excluded.state = 'linked' and excluded.source = 'manual' then 'linked'
                       when sik.state in ('linked', 'rejected') then sik.state
                       else excluded.state
                     end,
             source = case when sik.source = 'manual' or excluded.source = 'manual' then 'manual' else excluded.source end,
             confidence = coalesce(excluded.confidence, sik.confidence),
             decided_by = case when $7 then excluded.decided_by else sik.decided_by end,
             decided_at = case when $7 then excluded.decided_at else sik.decided_at end`,
      [submissionId, kindId, source, confidence, by, state, decided],
    );
  }

  /**
   * Once a person has put a report under a problem, the matcher's other guesses for it are stale:
   * they are dropped, not rejected, since nobody judged them. Suggestions made by people stay.
   */
  async clearRuleSuggestions(submissionId: string, keepKindId: string): Promise<void> {
    await this.db.query(
      `delete from luna_feedback.submission_issue_kinds
        where submission_id = $1 and kind_id <> $2 and state = 'suggested' and source = 'rule'`,
      [submissionId, keepKindId],
    );
  }

  /** "Not this problem": kept as rejected so it is never suggested again. False when there was nothing to reject. */
  async reject(submissionId: string, kindId: string, by: string | null): Promise<boolean> {
    const r = await this.db.query(
      `update luna_feedback.submission_issue_kinds
          set state = 'rejected', source = 'manual', decided_by = $3, decided_at = now()
        where submission_id = $1 and kind_id = $2 and state <> 'rejected'`,
      [submissionId, kindId, by],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Links shown on a report: confirmed and suggested ones. Rejected ones are remembered, not shown. */
  async forSubmission(submissionId: string): Promise<KindLink[]> {
    const r = await this.db.query<KindLink>(
      `select k.id as kind_id, k.ref, k.key, k.title, k.status, k.severity, k.jira_key, k.jira_url,
              sk.source, sk.state, sk.confidence::float8 as confidence, sk.created_by, sk.created_at, sk.decided_by, sk.decided_at, sk.regression
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
        where sk.submission_id = $1 and sk.state <> 'rejected'
        order by case when sk.state = 'linked' then 0 else 1 end, sk.created_at`,
      [submissionId],
    );
    return r.rows;
  }

  /** Every link row for one report, rejected ones included, so callers can skip what a person already refused. */
  async decidedKindIds(submissionId: string): Promise<Set<string>> {
    const r = await this.db.query<{ kind_id: string }>(
      `select kind_id from luna_feedback.submission_issue_kinds where submission_id = $1`, [submissionId],
    );
    return new Set(r.rows.map((x) => x.kind_id));
  }

  /** All-time size of each problem, counting reports that share `isTest` with the one being looked at. */
  async countsFor(kindIds: string[], isTest: boolean): Promise<Map<string, KindCounts>> {
    const out = new Map<string, KindCounts>();
    if (!kindIds.length) return out;
    const r = await this.db.query<KindCounts & { kind_id: string }>(
      `select sk.kind_id,
              count(*)::int as count,
              count(distinct ${personSql()})::int as users,
              count(*) filter (where s.origin = 'cx')::int as cx_count,
              count(distinct ${personSql()}) filter (where s.origin = 'cx')::int as cx_users,
              min(s.occurred_on)::text as first_seen,
              max(s.occurred_on)::text as last_seen
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.submissions s on s.id = sk.submission_id
        where sk.kind_id = any($1::uuid[]) and ${LINKED} and s.is_test = $2
        group by sk.kind_id`,
      [kindIds, isTest],
    );
    for (const row of r.rows) { const { kind_id, ...c } = row; out.set(kind_id, c); }
    return out;
  }

  /**
   * Folds one problem into another in a single transaction: its links move over (a confirmed link
   * beats a suggestion beats a rejection), its title becomes an alias of the survivor, and it is
   * archived with a pointer to where its reports went.
   */
  async merge(fromId: string, intoId: string): Promise<void> {
    const c = await this.db.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into luna_feedback.submission_issue_kinds as sik
                (submission_id, kind_id, source, confidence, created_by, created_at, state, decided_by, decided_at)
         select submission_id, $2, source, confidence, created_by, created_at, state, decided_by, decided_at
           from luna_feedback.submission_issue_kinds where kind_id = $1
         on conflict (submission_id, kind_id) do update
           set state = case
                         when sik.state = 'linked' or excluded.state = 'linked' then 'linked'
                         when sik.state = 'suggested' or excluded.state = 'suggested' then 'suggested'
                         else 'rejected'
                       end`,
        [fromId, intoId],
      );
      await c.query(`delete from luna_feedback.submission_issue_kinds where kind_id = $1`, [fromId]);
      await c.query(
        `update luna_feedback.issue_kinds k
            set aliases = (select coalesce(array_agg(distinct a), '{}') from unnest(k.aliases || f.aliases || array[f.title]) as a where a <> k.title),
                tags = (select coalesce(array_agg(distinct t), '{}') from unnest(k.tags || f.tags) as t),
                event_codes = (select coalesce(array_agg(distinct e), '{}') from unnest(k.event_codes || f.event_codes) as e),
                reference_submission_id = coalesce(k.reference_submission_id, f.reference_submission_id),
                jira_key = coalesce(k.jira_key, f.jira_key),
                jira_url = case when k.jira_key is null then f.jira_url else k.jira_url end
           from luna_feedback.issue_kinds f
          where k.id = $2 and f.id = $1`,
        [fromId, intoId],
      );
      await c.query(`update luna_feedback.issue_kinds set merged_into = $2, is_archived = true where id = $1`, [fromId, intoId]);
      // Anything that was merged into the one going away now points at the survivor.
      await c.query(`update luna_feedback.issue_kinds set merged_into = $2 where merged_into = $1`, [fromId, intoId]);
      await c.query('commit');
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
  }

  async submissionRef(id: string): Promise<string | null> {
    const r = await this.db.query<{ ref: string }>(`select ref from luna_feedback.submissions where id = $1`, [id]);
    return r.rows[0]?.ref ?? null;
  }

  /** Kind links for many submissions at once, so a list page does not fan out one query per row. */
  async forSubmissions(ids: string[]): Promise<Map<string, { id: string; ref: string; key: string; title: string }[]>> {
    const out = new Map<string, { id: string; ref: string; key: string; title: string }[]>();
    if (!ids.length) return out;
    const r = await this.db.query<{ submission_id: string; id: string; ref: string; key: string; title: string }>(
      `select sk.submission_id, k.id, k.ref, k.key, k.title
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
        where sk.submission_id = any($1::uuid[]) and ${LINKED}`,
      [ids],
    );
    for (const row of r.rows) {
      const list = out.get(row.submission_id) ?? [];
      list.push({ id: row.id, ref: row.ref, key: row.key, title: row.title });
      out.set(row.submission_id, list);
    }
    return out;
  }

  // ---- pinpointing -----------------------------------------------------------

  /** The versions a report ran, the logs' reading first. */
  async reportVersions(submissionId: string): Promise<ReportVersions | undefined> {
    const r = await this.db.query<ReportVersions>(
      `select s.id, s.ref, s.is_test, s.is_positive, s.platform,
              coalesce(d.app_version_seen, s.app_version) as app_version,
              coalesce(d.fw_version_seen, s.firmware_version) as firmware_version
         from luna_feedback.submissions s
         left join luna_feedback.diagnoses d on d.submission_id = s.id
        where s.id = $1`,
      [submissionId],
    );
    return r.rows[0];
  }

  /** Flags the link as a regression; `reopen` also moves a fixed problem back to watching. */
  async markRegression(submissionId: string, kindId: string, reopen: boolean): Promise<void> {
    await this.db.query(
      `update luna_feedback.submission_issue_kinds set regression = true where submission_id = $1 and kind_id = $2`,
      [submissionId, kindId],
    );
    await this.db.query(
      `update luna_feedback.issue_kinds
          set regressed_at = now(), status = case when $2 and status = 'fixed' then 'watching' else status end
        where id = $1`,
      [kindId, reopen],
    );
  }

  /** The reports that showed the problem on its fix version or later, newest first. */
  async regressions(kindId: string, limit = 10): Promise<{ id: string; ref: string; app_version: string | null; firmware_version: string | null; platform: string | null; linked_at: string }[]> {
    const r = await this.db.query<{ id: string; ref: string; app_version: string | null; firmware_version: string | null; platform: string | null; linked_at: Date }>(
      `select s.id, s.ref, s.platform,
              coalesce(d.app_version_seen, s.app_version) as app_version,
              coalesce(d.fw_version_seen, s.firmware_version) as firmware_version,
              coalesce(sk.decided_at, sk.created_at) as linked_at
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.submissions s on s.id = sk.submission_id
         left join luna_feedback.diagnoses d on d.submission_id = s.id
        where sk.kind_id = $1 and ${LINKED} and sk.regression
        order by coalesce(sk.decided_at, sk.created_at) desc
        limit $2`,
      [kindId, limit],
    );
    return r.rows.map((x) => ({ ...x, linked_at: new Date(x.linked_at).toISOString() }));
  }

  /**
   * How often each firmware, app version, platform and phone OS appears among a problem's reports,
   * next to how often it appears among all problem reports in the same slice. App and OS versions
   * carry the platform ("ios 2.4.0"), since the two apps number their versions separately.
   */
  async skew(kindId: string, filters: Partial<CommonFilters> & { from?: string; to?: string }): Promise<SkewRow[]> {
    const { where, vals } = buildWhere(filters);
    const params = [...vals, kindId];
    const r = await this.db.query<SkewRow>(
      `with base as (
         select coalesce(d.fw_version_seen, s.firmware_version) as firmware,
                case when coalesce(d.app_version_seen, s.app_version) is null then null
                     else concat_ws(' ', s.platform, coalesce(d.app_version_seen, s.app_version)) end as app,
                s.platform,
                case when s.os_version is null then null else concat_ws(' ', s.platform, s.os_version) end as os,
                exists (select 1 from luna_feedback.submission_issue_kinds sk
                         where sk.submission_id = s.id and sk.kind_id = $${params.length}::uuid and ${LINKED}) as in_kind
           from luna_feedback.submissions s
           left join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where ? where + ' and' : 'where'} not s.is_positive)
       select v.dim, v.value, count(*) filter (where b.in_kind)::int as kind_count, count(*)::int as base_count
         from base b
         cross join lateral (values ('firmware', b.firmware), ('app', b.app), ('platform', b.platform), ('os', b.os)) as v(dim, value)
        where v.value is not null
        group by v.dim, v.value`,
      params,
    );
    return r.rows;
  }

  /** Every firmware and app version a problem has been reported on, all time, for "oldest version seen". */
  async versionsSeen(kindId: string, isTest: boolean | null): Promise<{ platform: string | null; app_version: string | null; firmware_version: string | null }[]> {
    const r = await this.db.query<{ platform: string | null; app_version: string | null; firmware_version: string | null }>(
      `select distinct s.platform,
              coalesce(d.app_version_seen, s.app_version) as app_version,
              coalesce(d.fw_version_seen, s.firmware_version) as firmware_version
         from luna_feedback.submission_issue_kinds sk
         join luna_feedback.submissions s on s.id = sk.submission_id
         left join luna_feedback.diagnoses d on d.submission_id = s.id
        where sk.kind_id = $1 and ${LINKED} and ($2::boolean is null or s.is_test = $2) and not s.is_positive`,
      [kindId, isTest],
    );
    return r.rows;
  }
}
