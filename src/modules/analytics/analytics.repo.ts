import type { Db } from '../../db/pool.js';
import { buildWhere, personSql, type StatsFilters } from '../feedback/feedback.repo.js';
import { EVENTS_BY_ID } from '../diagnosis/knowledge/catalog.js';

export interface AnalyticsResult {
  range: { from: string; to: string };
  totals: {
    submissions: number; issues: number; positive: number; users: number;
    with_jira: number; open_issues: number; closed_issues: number; diagnosed: number;
  };
  by_day: { date: string; positive: number; negative: number }[];
  by_environment: { environment: string; issues: number; positive: number; users: number }[];
  by_origin: { origin: string; issues: number; positive: number; users: number }[];
  by_status: { status: string; count: number }[];
  by_feature: { feature_key: string; label: string; issues: number; positive: number }[];
  by_category: { feature_key: string; key: string; label: string; count: number; users: number }[];
  by_side: { side: string; count: number }[];
  by_severity: { severity: string; count: number }[];
  by_tag: { tag: string; count: number }[];
  by_event: { code: string; count: number; event: string | null; domain: string | null; severity: string | null; area: string | null; priority: string | null }[];
  by_kind: { id: string; key: string; title: string; status: string; jira_key: string | null; count: number; users: number; share: number; first_seen: string | null; last_seen: string | null }[];
  /** Who reports most. A CX customer has no email: they show by ring serial until their user id is resolved. */
  top_reporters: { user_id: number | null; email: string | null; device_serial: string | null; origin: string; issues: number; features: number }[];
  firmware_versions: { version: string; issues: number; firmware_side: number }[];
  app_versions: { version: string; platform: string | null; issues: number; app_side: number }[];
  jira: { linked: number; unlinked: number; by_status: { status: string; count: number }[] };
  /**
   * How fast the team responds, per origin: hours from a report arriving to the team's first action,
   * and to it being resolved. Medians and 90th percentiles over the reports that got there.
   */
  response_times: {
    origin: string; issues: number;
    touched: number; first_response_p50_h: number | null; first_response_p90_h: number | null;
    resolved: number; resolve_p50_h: number | null; resolve_p90_h: number | null;
  }[];
  /** Average and median hours reports spend in each open status, from the activity log. */
  time_in_status: { status: string; stints: number; avg_hours: number; p50_hours: number }[];
  /**
   * Did testing catch it before customers did? For every problem whose first customer report falls
   * in the range: whether an internal report was linked to it earlier, and by how long.
   */
  caught_first: CaughtFirst;
}

export interface CaughtFirstProblem {
  id: string; ref: string; title: string; status: string; feature_key: string | null; feature_label: string | null;
  first_cx_at: string; first_internal_at: string | null; cx_reports: number; customers: number; internal_reports: number;
  /** Days internal testing was ahead; null when a customer reported it first. */
  lead_days: number | null;
}

export interface CaughtFirst {
  problems: number;
  caught: number;
  missed: number;
  lead_p50_days: number | null;
  by_feature: { feature_key: string | null; label: string | null; problems: number; caught: number; missed: number }[];
  /** Problems a customer reported first, most customer reports first. */
  missed_items: CaughtFirstProblem[];
}

/**
 * Read-only aggregates for the analytics page.
 *
 * Every query is built from the same filter slice, so any two numbers on the page can be
 * compared without asking which filters each one honoured.
 */
export class AnalyticsRepo {
  constructor(private readonly db: Db) {}

  async overview(f: StatsFilters): Promise<AnalyticsResult> {
    const { where, vals } = buildWhere(f);
    const base = `from luna_feedback.submissions s ${where}`;
    const q = <T extends Record<string, unknown>>(sql: string) => this.db.query<T>(sql, vals);
    const issuesOnly = where ? `${where} and not s.is_positive` : 'where not s.is_positive';

    const [
      totals, byDay, byEnvironment, byOrigin, byStatus, byFeature, byCategory,
      bySide, bySeverity, byTag, byEvent, byKind, topReporters, fwVersions, appVersions, jiraByStatus,
      responseTimes, timeInStatus, caughtFirst,
    ] = await Promise.all([
      q<{ submissions: number; issues: number; positive: number; users: number; with_jira: number; open_issues: number; closed_issues: number; diagnosed: number }>(
        `select count(*)::int as submissions,
                count(*) filter (where not s.is_positive)::int as issues,
                count(*) filter (where s.is_positive)::int as positive,
                count(distinct ${personSql()})::int as users,
                count(*) filter (where s.jira_key is not null)::int as with_jira,
                count(*) filter (where not s.is_positive and s.status in ('open','triaged','in_progress','needs_info'))::int as open_issues,
                count(*) filter (where not s.is_positive and s.status in ('resolved','closed','wont_fix'))::int as closed_issues,
                count(*) filter (where s.ai_status = 'done')::int as diagnosed
         ${base}`),

      q<{ date: string; positive: number; negative: number }>(
        `select s.occurred_on::text as date,
                count(*) filter (where s.is_positive)::int as positive,
                count(*) filter (where not s.is_positive)::int as negative
         ${base} group by s.occurred_on order by s.occurred_on`),

      q<{ environment: string; issues: number; positive: number; users: number }>(
        `select s.environment,
                count(*) filter (where not s.is_positive)::int as issues,
                count(*) filter (where s.is_positive)::int as positive,
                count(distinct ${personSql()})::int as users
         ${base} group by s.environment order by issues desc`),

      q<{ origin: string; issues: number; positive: number; users: number }>(
        `select s.origin,
                count(*) filter (where not s.is_positive)::int as issues,
                count(*) filter (where s.is_positive)::int as positive,
                count(distinct ${personSql()})::int as users
         ${base} group by s.origin order by s.origin desc`),

      q<{ status: string; count: number }>(
        `select s.status, count(*)::int as count from luna_feedback.submissions s ${issuesOnly} group by s.status order by count desc`),

      q<{ feature_key: string; label: string; issues: number; positive: number }>(
        `select f.key as feature_key, f.label,
                coalesce(count(s.id) filter (where not s.is_positive), 0)::int as issues,
                coalesce(count(s.id) filter (where s.is_positive), 0)::int as positive
         from luna_feedback.features f
         left join luna_feedback.submissions s on s.feature_key = f.key ${where ? 'and ' + where.replace(/^where /, '') : ''}
         where f.is_active group by f.key, f.label, f.sort_order order by f.sort_order`),

      q<{ feature_key: string; key: string; label: string; count: number; users: number }>(
        `select s.feature_key, c.key, coalesce(ic.label, c.key) as label,
                count(*)::int as count, count(distinct ${personSql()})::int as users
         from luna_feedback.submissions s
         cross join lateral unnest(s.issue_categories) as c(key)
         left join luna_feedback.issue_categories ic on ic.feature_key = s.feature_key and ic.key = c.key
         ${where} group by s.feature_key, c.key, ic.label order by count desc limit 25`),

      q<{ side: string; count: number }>(
        `select s.ai_side as side, count(*)::int as count ${base} ${where ? 'and' : 'where'} s.ai_side is not null
         group by s.ai_side order by count desc`),

      q<{ severity: string; count: number }>(
        `select s.ai_severity as severity, count(*)::int as count ${base} ${where ? 'and' : 'where'} s.ai_severity is not null
         group by s.ai_severity order by count desc`),

      q<{ tag: string; count: number }>(
        `select t.tag, count(*)::int as count
         from luna_feedback.submissions s
         join luna_feedback.diagnoses d on d.submission_id = s.id
         cross join lateral unnest(d.tags) as t(tag)
         ${where} group by t.tag order by count desc limit 15`),

      q<{ code: string; count: number }>(
        `select e.code, count(*)::int as count
         from luna_feedback.submissions s
         cross join lateral unnest(s.ai_event_codes) as e(code)
         ${where} group by e.code order by count desc limit 20`),

      q<{ id: string; key: string; title: string; status: string; jira_key: string | null; count: number; users: number; first_seen: string | null; last_seen: string | null }>(
        `select k.id, k.key, k.title, k.status, k.jira_key,
                count(*)::int as count, count(distinct ${personSql()})::int as users,
                min(s.occurred_on)::text as first_seen, max(s.occurred_on)::text as last_seen
         from luna_feedback.submissions s
         join luna_feedback.submission_issue_kinds sk on sk.submission_id = s.id and sk.state = 'linked'
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
         ${where} group by k.id, k.key, k.title, k.status, k.jira_key order by count desc limit 20`),

      q<{ user_id: string | null; email: string | null; device_serial: string | null; origin: string; issues: number; features: number }>(
        `select min(s.user_id) as user_id, min(s.email) as email, min(s.device_serial) as device_serial,
                case when bool_or(s.origin = 'cx') then 'cx' else 'internal' end as origin,
                count(*)::int as issues, count(distinct s.feature_key)::int as features
         from luna_feedback.submissions s ${issuesOnly} group by ${personSql()} order by issues desc limit 10`),

      q<{ version: string; issues: number; firmware_side: number }>(
        `select coalesce(d.fw_version_seen, s.firmware_version) as version, count(*)::int as issues,
                count(*) filter (where d.root_cause_side = 'firmware')::int as firmware_side
         from luna_feedback.submissions s left join luna_feedback.diagnoses d on d.submission_id = s.id
         ${issuesOnly} and coalesce(d.fw_version_seen, s.firmware_version) is not null
         group by 1 order by issues desc limit 10`),

      q<{ version: string; platform: string | null; issues: number; app_side: number }>(
        `select coalesce(d.app_version_seen, s.app_version) as version, s.platform, count(*)::int as issues,
                count(*) filter (where d.root_cause_side in ('app','sdk'))::int as app_side
         from luna_feedback.submissions s left join luna_feedback.diagnoses d on d.submission_id = s.id
         ${issuesOnly} and coalesce(d.app_version_seen, s.app_version) is not null
         group by 1, 2 order by issues desc limit 10`),

      q<{ status: string; count: number }>(
        `select coalesce(s.jira_status, 'unknown') as status, count(*)::int as count
         ${base} ${where ? 'and' : 'where'} s.jira_key is not null group by 1 order by count desc`),

      q<{ origin: string; issues: number; touched: number; first_response_p50_h: number | null; first_response_p90_h: number | null; resolved: number; resolve_p50_h: number | null; resolve_p90_h: number | null }>(
        `with t as (
           select s.origin,
                  extract(epoch from s.first_touched_at - s.created_at) / 3600 as first_h,
                  extract(epoch from s.resolved_at - s.created_at) / 3600 as resolve_h
             from luna_feedback.submissions s ${issuesOnly})
         select origin, count(*)::int as issues,
                count(first_h)::int as touched,
                percentile_cont(0.5) within group (order by first_h) filter (where first_h is not null) as first_response_p50_h,
                percentile_cont(0.9) within group (order by first_h) filter (where first_h is not null) as first_response_p90_h,
                count(resolve_h)::int as resolved,
                percentile_cont(0.5) within group (order by resolve_h) filter (where resolve_h is not null) as resolve_p50_h,
                percentile_cont(0.9) within group (order by resolve_h) filter (where resolve_h is not null) as resolve_p90_h
           from t group by origin order by origin desc`),

      q<{ status: string; stints: number; avg_hours: number; p50_hours: number }>(
        `with st as (
           select case when e.action = 'created' then 'open' else e.to_value end as status,
                  e.created_at as since,
                  lead(e.created_at) over (partition by e.submission_id order by e.created_at, e.id) as until
             from luna_feedback.submission_events e
             join luna_feedback.submissions s on s.id = e.submission_id
            ${issuesOnly} and e.action in ('created', 'status'))
         select status, count(*)::int as stints,
                (avg(extract(epoch from coalesce(until, now()) - since)) / 3600)::float8 as avg_hours,
                (percentile_cont(0.5) within group (order by extract(epoch from coalesce(until, now()) - since)) / 3600)::float8 as p50_hours
           from st where status in ('open', 'triaged', 'in_progress', 'needs_info')
          group by status order by array_position(array['open','triaged','in_progress','needs_info'], status)`),

      this.caughtFirst(f),
    ]);

    const t = totals.rows[0]!;
    const issueTotal = t.issues || 1;

    return {
      range: { from: f.from, to: f.to },
      totals: t,
      by_day: byDay.rows,
      by_environment: byEnvironment.rows,
      by_origin: byOrigin.rows,
      by_status: byStatus.rows,
      by_feature: byFeature.rows,
      by_category: byCategory.rows,
      by_side: bySide.rows,
      by_severity: bySeverity.rows,
      by_tag: byTag.rows,
      // Joined in the app rather than the database: the catalog is a build artifact, not a table.
      by_event: byEvent.rows.map((row) => {
        const meta = EVENTS_BY_ID.get(row.code);
        return {
          code: row.code, count: row.count,
          event: meta?.event ?? null, domain: meta?.domain ?? null,
          severity: meta?.severity ?? null, area: meta?.area ?? null, priority: meta?.priority ?? null,
        };
      }),
      by_kind: byKind.rows.map((row) => ({ ...row, share: row.count / issueTotal })),
      top_reporters: topReporters.rows.map((row) => ({ ...row, user_id: row.user_id === null ? null : Number(row.user_id) })),
      firmware_versions: fwVersions.rows,
      app_versions: appVersions.rows,
      jira: {
        linked: t.with_jira,
        unlinked: t.submissions - t.with_jira,
        by_status: jiraByStatus.rows,
      },
      response_times: responseTimes.rows.map((r) => ({
        ...r,
        first_response_p50_h: r.first_response_p50_h === null ? null : Number(r.first_response_p50_h),
        first_response_p90_h: r.first_response_p90_h === null ? null : Number(r.first_response_p90_h),
        resolve_p50_h: r.resolve_p50_h === null ? null : Number(r.resolve_p50_h),
        resolve_p90_h: r.resolve_p90_h === null ? null : Number(r.resolve_p90_h),
      })),
      time_in_status: timeInStatus.rows,
      caught_first: caughtFirst,
    };
  }

  /**
   * Problems whose first customer report is in the range, and whether an internal report came first.
   * Source and environment filters do not apply: the point is comparing the two sources, and an
   * internal report from stage counts as testing having caught it. The feature filter does.
   */
  async caughtFirst(f: StatsFilters): Promise<CaughtFirst> {
    const params: unknown[] = [f.is_test ?? false, f.from, f.to];
    let featureClause = '';
    if (f.feature) { params.push(f.feature); featureClause = `and p.feature_key = $${params.length}`; }
    const r = await this.db.query<Omit<CaughtFirstProblem, 'lead_days' | 'first_cx_at' | 'first_internal_at'> & { first_cx_at: Date; first_internal_at: Date | null }>(
      `with p as (
         select k.id, k.ref, k.title, k.status,
                coalesce(k.feature_key, (array_agg(s.feature_key order by s.created_at))[1]) as feature_key,
                min(s.created_at) filter (where s.origin = 'cx') as first_cx_at,
                min(s.occurred_on) filter (where s.origin = 'cx') as first_cx_on,
                min(s.created_at) filter (where s.origin = 'internal') as first_internal_at,
                count(*) filter (where s.origin = 'cx')::int as cx_reports,
                count(distinct ${personSql()}) filter (where s.origin = 'cx')::int as customers,
                count(*) filter (where s.origin = 'internal')::int as internal_reports
           from luna_feedback.issue_kinds k
           join luna_feedback.submission_issue_kinds sk on sk.kind_id = k.id and sk.state = 'linked'
           join luna_feedback.submissions s on s.id = sk.submission_id
          where not s.is_positive and s.is_test = $1 and k.merged_into is null
          group by k.id, k.ref, k.title, k.status, k.feature_key)
       select p.id, p.ref, p.title, p.status, p.feature_key, f.label as feature_label,
              p.first_cx_at, p.first_internal_at, p.cx_reports, p.customers, p.internal_reports
         from p left join luna_feedback.features f on f.key = p.feature_key
        where p.first_cx_at is not null and p.first_cx_on between $2::date and $3::date ${featureClause}
        order by p.cx_reports desc, p.first_cx_at desc`,
      params,
    );

    const items: CaughtFirstProblem[] = r.rows.map((x) => {
      const cx = new Date(x.first_cx_at).getTime();
      const internal = x.first_internal_at ? new Date(x.first_internal_at).getTime() : null;
      return {
        ...x,
        first_cx_at: new Date(cx).toISOString(),
        first_internal_at: internal === null ? null : new Date(internal).toISOString(),
        lead_days: internal !== null && internal < cx ? Math.round(((cx - internal) / 86_400_000) * 10) / 10 : null,
      };
    });
    const caught = items.filter((x) => x.lead_days !== null);
    const leads = caught.map((x) => x.lead_days!).sort((a, b) => a - b);
    const median = leads.length ? (leads.length % 2 ? leads[(leads.length - 1) / 2]! : (leads[leads.length / 2 - 1]! + leads[leads.length / 2]!) / 2) : null;

    const byFeature = new Map<string, CaughtFirst['by_feature'][number]>();
    for (const x of items) {
      const key = x.feature_key ?? '';
      const row = byFeature.get(key) ?? { feature_key: x.feature_key, label: x.feature_label, problems: 0, caught: 0, missed: 0 };
      row.problems += 1;
      if (x.lead_days !== null) row.caught += 1; else row.missed += 1;
      byFeature.set(key, row);
    }
    return {
      problems: items.length,
      caught: caught.length,
      missed: items.length - caught.length,
      lead_p50_days: median === null ? null : Math.round(median * 10) / 10,
      by_feature: [...byFeature.values()].sort((a, b) => b.missed - a.missed || b.problems - a.problems),
      missed_items: items.filter((x) => x.lead_days === null).slice(0, 15),
    };
  }
}
