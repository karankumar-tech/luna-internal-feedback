import type { Db } from '../../db/pool.js';
import { buildWhere, personSql, type CommonFilters } from '../feedback/feedback.repo.js';

/** One report as the home list shows it: only what a list item needs, so a page of 25 stays small. */
export interface HomeReport {
  id: string;
  ref: string;
  created_at: string;
  occurred_on: string;
  feature_key: string;
  is_positive: boolean;
  issue_categories: string[];
  feedback_text: string | null;
  origin: 'internal' | 'cx';
  environment: string;
  status: string;
  priority: string | null;
  tags: string[];
  assigned_to: string | null;
  owner_name: string | null;
  user_id: number | null;
  /** Internal reports only; never on a CX report. */
  email: string | null;
  /** The dashboard account with that email, when there is one: a name to show instead of the id. */
  tester_name: string | null;
  device_serial: string | null;
  cx_ref: string | null;
  ai_status: string | null;
  ai_side: string | null;
  ai_severity: string | null;
  jira_key: string | null;
  is_test: boolean;
  /** Problems the report is confirmed under, each with how many real reports it has in all. */
  kinds: { id: string; ref: string; title: string; reports: number }[];
}

export interface HomeListFilters extends Partial<CommonFilters> {
  from?: string;
  to?: string;
  /** Received (not happened) within the last N days, counting today, in the app's time zone. */
  receivedDays?: number;
  /** Still needs someone: not resolved, closed or won't fix. */
  openOnly?: boolean;
}

export interface HomeSummaryRow {
  today: number; today_cx: number;
  week: number; week_cx: number; week_people: number;
  prev_week: number;
}

export interface HomeCategoryRow { feature_key: string; key: string; count: number; cx: number }

export class HomeRepo {
  constructor(private readonly db: Db, private readonly timeZone: string) {}

  /**
   * A page of reports, newest first, with the total in the same query. Each report carries its
   * owner's name and its problems, so the list needs no follow-up requests.
   */
  async reports(f: HomeListFilters, today: string, page: number, pageSize: number): Promise<{ items: HomeReport[]; total: number }> {
    const { where, vals } = buildWhere(f);
    const clauses = where ? [where.replace(/^where /, '')] : [];
    if (f.openOnly) clauses.push(`s.status not in ('resolved', 'closed', 'wont_fix')`);
    if (f.receivedDays) {
      vals.push(this.timeZone, today, f.receivedDays);
      clauses.push(`(s.created_at at time zone $${vals.length - 2})::date > $${vals.length - 1}::date - $${vals.length}::int`);
    }
    vals.push(pageSize, (page - 1) * pageSize);
    const r = await this.db.query<Omit<HomeReport, 'created_at' | 'user_id'> & { created_at: Date; user_id: string | null; total: string }>(
      `select s.id, s.ref, s.created_at, s.occurred_on::text as occurred_on, s.feature_key, s.is_positive, s.issue_categories,
              s.feedback_text, s.origin, s.environment, s.status, s.priority, s.tags, s.assigned_to, u.name as owner_name,
              s.user_id::text as user_id, s.email, t.name as tester_name, s.device_serial, s.cx_ref, s.ai_status, s.ai_side, s.ai_severity, s.jira_key, s.is_test,
              coalesce(k.kinds, '[]'::json) as kinds,
              count(*) over () as total
         from luna_feedback.submissions s
         left join luna_feedback.dashboard_users u on u.email = s.assigned_to
         left join luna_feedback.dashboard_users t on t.email = lower(s.email)
         left join lateral (
           select json_agg(json_build_object(
                    'id', kk.id, 'ref', kk.ref, 'title', kk.title,
                    'reports', (select count(*) from luna_feedback.submission_issue_kinds x
                                  join luna_feedback.submissions y on y.id = x.submission_id
                                 where x.kind_id = kk.id and x.state = 'linked' and not y.is_test))
                  order by sk.created_at) as kinds
             from luna_feedback.submission_issue_kinds sk
             join luna_feedback.issue_kinds kk on kk.id = sk.kind_id
            where sk.submission_id = s.id and sk.state = 'linked'
         ) k on true
        ${clauses.length ? 'where ' + clauses.join(' and ') : ''}
        order by s.created_at desc, s.id desc
        limit $${vals.length - 1} offset $${vals.length}`,
      vals,
    );
    let total = r.rows[0] ? Number(r.rows[0].total) : 0;
    if (!r.rows.length && page > 1) {
      // Past the last page: the window function has no row to report the total on.
      const c = await this.db.query<{ n: string }>(
        `select count(*) as n from luna_feedback.submissions s ${clauses.length ? 'where ' + clauses.join(' and ') : ''}`,
        vals.slice(0, -2),
      );
      total = Number(c.rows[0]?.n ?? 0);
    }
    return {
      total,
      items: r.rows.map(({ total: _t, ...x }) => ({
        ...x,
        created_at: new Date(x.created_at).toISOString(),
        user_id: x.user_id === null ? null : Number(x.user_id),
      })),
    };
  }

  /** Real issues received today, in the last 7 days and in the 7 days before, by the app's calendar. */
  async summary(today: string): Promise<HomeSummaryRow> {
    const r = await this.db.query<HomeSummaryRow>(
      `with d as (
         select (s.created_at at time zone $1)::date as day, s.origin, ${personSql()} as person
           from luna_feedback.submissions s
          where not s.is_test and not s.is_positive
            and s.created_at >= (($2::date - 13)::timestamp at time zone $1))
       select count(*) filter (where day = $2::date)::int as today,
              count(*) filter (where day = $2::date and origin = 'cx')::int as today_cx,
              count(*) filter (where day > $2::date - 7)::int as week,
              count(*) filter (where day > $2::date - 7 and origin = 'cx')::int as week_cx,
              count(distinct person) filter (where day > $2::date - 7)::int as week_people,
              count(*) filter (where day <= $2::date - 7)::int as prev_week
         from d`,
      [this.timeZone, today],
    );
    return r.rows[0]!;
  }

  /** Real issues received in the last 7 days, per feature category, most reported first. */
  async categories(today: string, limit: number): Promise<HomeCategoryRow[]> {
    const r = await this.db.query<HomeCategoryRow>(
      `select s.feature_key, c.key, count(*)::int as count, count(*) filter (where s.origin = 'cx')::int as cx
         from luna_feedback.submissions s
         cross join lateral unnest(s.issue_categories) as c(key)
        where not s.is_test and not s.is_positive
          and (s.created_at at time zone $1)::date > $2::date - 7
        group by s.feature_key, c.key
        order by count(*) desc, s.feature_key, c.key
        limit $3`,
      [this.timeZone, today, limit],
    );
    return r.rows;
  }
}
