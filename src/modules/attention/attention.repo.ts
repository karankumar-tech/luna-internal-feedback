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
  /** Days since anyone last did something with it (status change or linking it to a problem by hand). */
  idle_days: number;
  /** Nobody has done anything with it: still open, no status change, no Jira ticket, no manual link. */
  untouched: boolean;
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
  reports: number;
  open_reports: number;
  people: number;
  cx_reports: number;
  last_seen: string | null;
}

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
              s.ai_severity, s.ai_status, s.cx_ref, s.jira_key, left(s.feedback_text, 160) as feedback_text,
              (extract(epoch from now() - s.created_at) / 86400)::float8 as age_days,
              (extract(epoch from now() - greatest(s.created_at, s.status_changed_at, m.last_link)) / 86400)::float8 as idle_days,
              (s.status = 'open' and s.status_changed_at is null and s.jira_key is null and m.last_link is null) as untouched,
              -- Ungrouped: just this reporter, and a customer counts twice, as they do on a problem.
              coalesce(ki.impact, case when s.origin = 'cx' then 2 else 1 end)::int as impact,
              coalesce(ki.kinds, '[]'::json) as kinds
         from luna_feedback.submissions s
         left join lateral (
           -- A person linking, confirming or rejecting a problem counts as touching the report.
           select max(greatest(sk.created_at, sk.decided_at)) as last_link
             from luna_feedback.submission_issue_kinds sk
            where sk.submission_id = s.id and sk.source = 'manual'
         ) m on true
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
   * Problems big enough to deserve their own ticket but without one: at least `minReports` reports,
   * or any report from a customer through CX, with at least one still open.
   */
  async kindsWithoutJira(f: Partial<CommonFilters>, minReports: number): Promise<KindWithoutJiraRow[]> {
    const { where, vals } = buildWhere(f);
    vals.push(minReports);
    const r = await this.db.query<KindWithoutJiraRow>(
      `select k.id, k.ref, k.title, k.status,
              count(*)::int as reports,
              count(*) filter (where s.status not in ${TERMINAL})::int as open_reports,
              count(distinct ${personSql()})::int as people,
              count(*) filter (where s.origin = 'cx')::int as cx_reports,
              max(s.occurred_on)::text as last_seen
         from luna_feedback.issue_kinds k
         join luna_feedback.submission_issue_kinds sk on sk.kind_id = k.id and sk.state = 'linked'
         join luna_feedback.submissions s on s.id = sk.submission_id
        ${where ? where + ' and' : 'where'} not s.is_positive
          and not k.is_archived and k.status in ('open', 'watching') and k.jira_key is null
        group by k.id, k.ref, k.title, k.status
       having count(*) filter (where s.status not in ${TERMINAL}) > 0
          and (count(*) >= $${vals.length} or count(*) filter (where s.origin = 'cx') > 0)
        order by count(*) filter (where s.origin = 'cx') desc, count(*) desc
        limit 25`,
      vals,
    );
    return r.rows;
  }
}
