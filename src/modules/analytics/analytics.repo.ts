import type { Db } from '../../db/pool.js';
import { buildWhere, type StatsFilters } from '../feedback/feedback.repo.js';
import { EVENTS_BY_ID } from '../diagnosis/knowledge/catalog.js';

export interface AnalyticsResult {
  range: { from: string; to: string };
  totals: {
    submissions: number; issues: number; positive: number; users: number;
    with_jira: number; open_issues: number; closed_issues: number; diagnosed: number;
  };
  by_day: { date: string; positive: number; negative: number }[];
  by_environment: { environment: string; issues: number; positive: number; users: number }[];
  by_status: { status: string; count: number }[];
  by_feature: { feature_key: string; label: string; issues: number; positive: number }[];
  by_category: { feature_key: string; key: string; label: string; count: number; users: number }[];
  by_side: { side: string; count: number }[];
  by_severity: { severity: string; count: number }[];
  by_tag: { tag: string; count: number }[];
  by_event: { code: string; count: number; event: string | null; domain: string | null; severity: string | null; area: string | null; priority: string | null }[];
  by_kind: { id: string; key: string; title: string; status: string; jira_key: string | null; count: number; users: number; share: number; first_seen: string | null; last_seen: string | null }[];
  top_reporters: { user_id: number; email: string; issues: number; features: number }[];
  firmware_versions: { version: string; issues: number; firmware_side: number }[];
  app_versions: { version: string; platform: string | null; issues: number; app_side: number }[];
  jira: { linked: number; unlinked: number; by_status: { status: string; count: number }[] };
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
      totals, byDay, byEnvironment, byStatus, byFeature, byCategory,
      bySide, bySeverity, byTag, byEvent, byKind, topReporters, fwVersions, appVersions, jiraByStatus,
    ] = await Promise.all([
      q<{ submissions: number; issues: number; positive: number; users: number; with_jira: number; open_issues: number; closed_issues: number; diagnosed: number }>(
        `select count(*)::int as submissions,
                count(*) filter (where not s.is_positive)::int as issues,
                count(*) filter (where s.is_positive)::int as positive,
                count(distinct s.user_id)::int as users,
                count(*) filter (where s.jira_key is not null)::int as with_jira,
                count(*) filter (where not s.is_positive and s.status in ('open','triaged','in_progress'))::int as open_issues,
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
                count(distinct s.user_id)::int as users
         ${base} group by s.environment order by issues desc`),

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
                count(*)::int as count, count(distinct s.user_id)::int as users
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
                count(*)::int as count, count(distinct s.user_id)::int as users,
                min(s.occurred_on)::text as first_seen, max(s.occurred_on)::text as last_seen
         from luna_feedback.submissions s
         join luna_feedback.submission_issue_kinds sk on sk.submission_id = s.id
         join luna_feedback.issue_kinds k on k.id = sk.kind_id
         ${where} group by k.id, k.key, k.title, k.status, k.jira_key order by count desc limit 20`),

      q<{ user_id: string; email: string; issues: number; features: number }>(
        `select s.user_id, min(s.email) as email, count(*)::int as issues, count(distinct s.feature_key)::int as features
         from luna_feedback.submissions s ${issuesOnly} group by s.user_id order by issues desc limit 10`),

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
    ]);

    const t = totals.rows[0]!;
    const issueTotal = t.issues || 1;

    return {
      range: { from: f.from, to: f.to },
      totals: t,
      by_day: byDay.rows,
      by_environment: byEnvironment.rows,
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
      top_reporters: topReporters.rows.map((row) => ({ ...row, user_id: Number(row.user_id) })),
      firmware_versions: fwVersions.rows,
      app_versions: appVersions.rows,
      jira: {
        linked: t.with_jira,
        unlinked: t.submissions - t.with_jira,
        by_status: jiraByStatus.rows,
      },
    };
  }
}
