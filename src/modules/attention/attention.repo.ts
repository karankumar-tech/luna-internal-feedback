import type { Db } from '../../db/pool.js';
import { buildWhere, personSql, type CommonFilters } from '../feedback/feedback.repo.js';

/** One open issue with what the attention page needs to decide whether, and how urgently, to show it. */
export interface OpenIssueRow {
  id: string;
  ref: string;
  feature_key: string;
  origin: 'internal' | 'cx';
  environment: string;
  status: string;
  created_at: Date;
  age_days: number;
  /** Days since the team last did something with it. */
  idle_days: number;
  /** Nobody on the team has done anything with it yet. */
  untouched: boolean;
  assigned_to: string | null;
  priority: string | null;
  ai_severity: string | null;
  ai_status: string | null;
  cx_ref: string | null;
  jira_key: string | null;
  feedback_text: string | null;
  /** People affected by the biggest problem this report is grouped under (a CX customer counts twice); when ungrouped, 1 (or 2 for a customer). */
  impact: number;
  kinds: { ref: string; title: string }[];
}

export interface KindWithoutJiraRow {
  id: string;
  ref: string;
  title: string;
  status: string;
  owner: string | null;
  jira_key: string | null;
  reports: number;
  open_reports: number;
  people: number;
  cx_reports: number;
  last_seen: string | null;
}

/** A problem's or a category's report counts over the recent days and the days before them. */
export interface SpikeCountRow { id: string; ref: string; title: string; status: string; owner: string | null; feature_key: string | null; recent: number; prior: number; cx_recent: number }
export interface CategorySpikeCountRow { feature_key: string; key: string; label: string; recent: number; prior: number; cx_recent: number }

export interface RegressionRow {
  id: string; ref: string; title: string; status: string; owner: string | null;
  fixed_in_app_version: string | null; fixed_in_firmware_version: string | null; regressed_at: Date;
  regression_reports: number;
  reports: { ref: string; platform: string | null; origin: string; app_version: string | null; firmware_version: string | null; linked_at: string }[];
}

export interface RepeatDeviceRow {
  device_serial: string | null;
  user_id: number | null;
  reports: number;
  cx_reports: number;
  features: number;
  open_reports: number;
  last_on: string;
  items: { ref: string; feature_key: string; occurred_on: string; status: string; origin: string }[];
}

export interface SameDeviceItem { id: string; ref: string; feature_key: string; occurred_on: string; status: string; origin: string }

const TERMINAL = `('resolved','closed','wont_fix')`;

export class AttentionRepo {
  constructor(private readonly db: Db) {}

  /** Every open (non-terminal) issue in the filter slice, with its age, idleness and impact. */
  async openIssues(f: Partial<CommonFilters>, limit = 2000): Promise<OpenIssueRow[]> {
    const { where, vals } = buildWhere(f);
    const conds = [where.replace(/^where /, ''), 'not s.is_positive', `s.status not in ${TERMINAL}`].filter(Boolean);
    const testClause = f.is_test === undefined ? '' : `and s2.is_test = ${f.is_test ? 'true' : 'false'}`;
    vals.push(limit);
    const r = await this.db.query<OpenIssueRow>(
      `with kind_impact as (
         select sk.kind_id,
                count(distinct ${personSql('s2')}) + count(distinct ${personSql('s2')}) filter (where s2.origin = 'cx') as impact
           from luna_feedback.submission_issue_kinds sk
           join luna_feedback.submissions s2 on s2.id = sk.submission_id
          where not s2.is_positive and sk.state = 'linked' ${testClause}
          group by sk.kind_id
       )
       select s.id, s.ref, s.feature_key, s.origin, s.environment, s.status, s.created_at,
              s.ai_severity, s.ai_status, s.cx_ref, s.jira_key, s.assigned_to, s.priority, left(s.feedback_text, 160) as feedback_text,
              (extract(epoch from now() - s.created_at) / 86400)::float8 as age_days,
              (extract(epoch from now() - coalesce(s.last_activity_at, s.created_at)) / 86400)::float8 as idle_days,
              (s.first_touched_at is null) as untouched,
              -- Ungrouped: just this reporter, and a customer counts twice, as they do on a problem.
              coalesce(ki.impact, case when s.origin = 'cx' then 2 else 1 end)::int as impact,
              coalesce(ki.kinds, '[]'::json) as kinds
         from luna_feedback.submissions s
         left join lateral (
           select max(kim.impact) as impact,
                  json_agg(json_build_object('ref', k.ref, 'title', k.title) order by k.ref) as kinds
             from luna_feedback.submission_issue_kinds sk
             join luna_feedback.issue_kinds k on k.id = sk.kind_id
             left join kind_impact kim on kim.kind_id = sk.kind_id
            where sk.submission_id = s.id and sk.state = 'linked'
         ) ki on true
        where ${conds.join(' and ')}
        order by s.created_at asc
        limit $${vals.length}`,
      vals,
    );
    return r.rows;
  }

  /**
   * Problems big enough to need an owner and their own ticket, but missing one or both: at least
   * `minReports` reports, or any report from a customer through CX, with at least one still open.
   */
  async kindsWithoutJira(f: Partial<CommonFilters>, minReports: number): Promise<KindWithoutJiraRow[]> {
    const { where, vals } = buildWhere(f);
    vals.push(minReports);
    const r = await this.db.query<KindWithoutJiraRow>(
      `select k.id, k.ref, k.title, k.status, k.owner, k.jira_key,
              count(*)::int as reports,
              count(*) filter (where s.status not in ${TERMINAL})::int as open_reports,
              count(distinct ${personSql()})::int as people,
              count(*) filter (where s.origin = 'cx')::int as cx_reports,
              max(s.occurred_on)::text as last_seen
         from luna_feedback.issue_kinds k
         join luna_feedback.submission_issue_kinds sk on sk.kind_id = k.id and sk.state = 'linked'
         join luna_feedback.submissions s on s.id = sk.submission_id
        ${where ? where + ' and' : 'where'} not s.is_positive
          and not k.is_archived and k.status in ('open', 'watching') and (k.jira_key is null or k.owner is null)
        group by k.id, k.ref, k.title, k.status, k.owner, k.jira_key
       having count(*) filter (where s.status not in ${TERMINAL}) > 0
          and (count(*) >= $${vals.length} or count(*) filter (where s.origin = 'cx') > 0)
        order by count(*) filter (where s.origin = 'cx') desc, count(*) desc
        limit 25`,
      vals,
    );
    return r.rows;
  }

  /**
   * Problems' report counts over the last `recentDays` and the `priorDays` before them, for problems
   * with at least `minRecent` recent reports. Days are report days (occurred_on) up to `today`.
   */
  async kindSpikeCounts(f: Partial<CommonFilters>, today: string, w: { recentDays: number; priorDays: number; minRecent: number }): Promise<SpikeCountRow[]> {
    const { where, vals } = buildWhere(f);
    vals.push(today, w.recentDays, w.recentDays + w.priorDays, w.minRecent);
    const n = vals.length;
    const r = await this.db.query<SpikeCountRow>(
      `select k.id, k.ref, k.title, k.status, k.owner, k.feature_key,
              count(*) filter (where s.occurred_on > $${n - 3}::date - $${n - 2}::int)::int as recent,
              count(*) filter (where s.occurred_on <= $${n - 3}::date - $${n - 2}::int)::int as prior,
              count(*) filter (where s.occurred_on > $${n - 3}::date - $${n - 2}::int and s.origin = 'cx')::int as cx_recent
         from luna_feedback.issue_kinds k
         join luna_feedback.submission_issue_kinds sk on sk.kind_id = k.id and sk.state = 'linked'
         join luna_feedback.submissions s on s.id = sk.submission_id
        ${where ? where + ' and' : 'where'} not s.is_positive and not k.is_archived
          and s.occurred_on > $${n - 3}::date - $${n - 1}::int and s.occurred_on <= $${n - 3}::date
        group by k.id, k.ref, k.title, k.status, k.owner, k.feature_key
       having count(*) filter (where s.occurred_on > $${n - 3}::date - $${n - 2}::int) >= $${n}
        order by recent desc`,
      vals,
    );
    return r.rows;
  }

  /** The same counts per feature category. Catch-all categories ("something else") say nothing about where, so they are left out. */
  async categorySpikeCounts(f: Partial<CommonFilters>, today: string, w: { recentDays: number; priorDays: number; minRecent: number }, skip: string[]): Promise<CategorySpikeCountRow[]> {
    const { where, vals } = buildWhere(f);
    vals.push(skip, today, w.recentDays, w.recentDays + w.priorDays, w.minRecent);
    const n = vals.length;
    const r = await this.db.query<CategorySpikeCountRow>(
      `select s.feature_key, c.key, coalesce(ic.label, c.key) as label,
              count(*) filter (where s.occurred_on > $${n - 3}::date - $${n - 2}::int)::int as recent,
              count(*) filter (where s.occurred_on <= $${n - 3}::date - $${n - 2}::int)::int as prior,
              count(*) filter (where s.occurred_on > $${n - 3}::date - $${n - 2}::int and s.origin = 'cx')::int as cx_recent
         from luna_feedback.submissions s
         cross join lateral unnest(s.issue_categories) as c(key)
         left join luna_feedback.issue_categories ic on ic.feature_key = s.feature_key and ic.key = c.key
        ${where ? where + ' and' : 'where'} not s.is_positive and not (c.key = any($${n - 4}::text[]))
          and s.occurred_on > $${n - 3}::date - $${n - 1}::int and s.occurred_on <= $${n - 3}::date
        group by s.feature_key, c.key, ic.label
       having count(*) filter (where s.occurred_on > $${n - 3}::date - $${n - 2}::int) >= $${n}
        order by recent desc`,
      vals,
    );
    return r.rows;
  }

  /** Problems a report on the fix version or later came back to within `days`, unless marked fixed again. */
  async recentRegressions(days: number): Promise<RegressionRow[]> {
    const r = await this.db.query<RegressionRow>(
      `select k.id, k.ref, k.title, k.status, k.owner, k.fixed_in_app_version, k.fixed_in_firmware_version, k.regressed_at,
              (select count(*)::int from luna_feedback.submission_issue_kinds sk
                where sk.kind_id = k.id and sk.state = 'linked' and sk.regression) as regression_reports,
              coalesce((select json_agg(x order by x.linked_at desc) from (
                 select s.ref, s.platform, s.origin,
                        coalesce(d.app_version_seen, s.app_version) as app_version,
                        coalesce(d.fw_version_seen, s.firmware_version) as firmware_version,
                        coalesce(sk.decided_at, sk.created_at) as linked_at
                   from luna_feedback.submission_issue_kinds sk
                   join luna_feedback.submissions s on s.id = sk.submission_id
                   left join luna_feedback.diagnoses d on d.submission_id = s.id
                  where sk.kind_id = k.id and sk.state = 'linked' and sk.regression
                  order by coalesce(sk.decided_at, sk.created_at) desc limit 5) x), '[]'::json) as reports
         from luna_feedback.issue_kinds k
        where k.regressed_at > now() - make_interval(days => $1) and k.status in ('open', 'watching') and not k.is_archived
        order by k.regressed_at desc
        limit 25`,
      [days],
    );
    return r.rows;
  }

  /**
   * Rings (or, for reports without a serial, people) with at least `minReports` problem reports in the
   * last `days` days. Customers first: for them this often means a faulty ring rather than a bug.
   */
  async repeatDevices(f: Partial<CommonFilters>, today: string, days: number, minReports: number): Promise<RepeatDeviceRow[]> {
    const { where, vals } = buildWhere(f);
    vals.push(today, days, minReports);
    const n = vals.length;
    const r = await this.db.query<RepeatDeviceRow>(
      `select s.device_serial, max(s.user_id)::text as user_id,
              count(*)::int as reports,
              count(*) filter (where s.origin = 'cx')::int as cx_reports,
              count(distinct s.feature_key)::int as features,
              count(*) filter (where s.status not in ${TERMINAL})::int as open_reports,
              max(s.occurred_on)::text as last_on,
              json_agg(json_build_object('ref', s.ref, 'feature_key', s.feature_key, 'occurred_on', s.occurred_on, 'status', s.status, 'origin', s.origin)
                       order by s.occurred_on desc, s.ref_no desc) as items
         from luna_feedback.submissions s
        ${where ? where + ' and' : 'where'} not s.is_positive
          and (s.device_serial is not null or s.user_id is not null)
          and s.occurred_on > $${n - 2}::date - $${n - 1}::int and s.occurred_on <= $${n - 2}::date
        group by s.device_serial, case when s.device_serial is null then s.user_id end
       having count(*) >= $${n}
        order by count(*) filter (where s.origin = 'cx') > 0 desc, count(*) desc, max(s.occurred_on) desc
        limit 25`,
      vals,
    );
    return r.rows.map((x) => ({ ...x, user_id: x.user_id === null ? null : Number(x.user_id) }));
  }

  /**
   * The problem reports from this report's ring (or, without a serial, its reporter) in the `days`
   * days up to and including its own, itself included. Test data only counts against test data.
   */
  async sameDevice(submissionId: string, days: number): Promise<{ by: 'ring' | 'person' | null; items: SameDeviceItem[] }> {
    const me = await this.db.query<{ device_serial: string | null; user_id: string | null; is_positive: boolean }>(
      `select device_serial, user_id::text as user_id, is_positive from luna_feedback.submissions where id = $1`, [submissionId],
    );
    const row = me.rows[0];
    if (!row || row.is_positive || (!row.device_serial && !row.user_id)) return { by: null, items: [] };
    const r = await this.db.query<SameDeviceItem>(
      `select s.id, s.ref, s.feature_key, s.occurred_on::text as occurred_on, s.status, s.origin
         from luna_feedback.submissions s
         join luna_feedback.submissions me on me.id = $1
        where not s.is_positive and s.is_test = me.is_test
          and case when me.device_serial is not null then s.device_serial = me.device_serial
                   else s.device_serial is null and s.user_id = me.user_id end
          and s.occurred_on > me.occurred_on - $2::int and s.occurred_on <= me.occurred_on
        order by s.occurred_on desc, s.ref_no desc
        limit 50`,
      [submissionId, days],
    );
    return { by: row.device_serial ? 'ring' : 'person', items: r.rows };
  }
}
