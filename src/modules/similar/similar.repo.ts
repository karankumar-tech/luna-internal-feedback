import type { Db } from '../../db/pool.js';
import type { Comparable } from './similarity.js';

/** A report with everything the matcher and the "Similar reports" panel need. */
export interface ReportForMatch extends Comparable {
  ref: string;
  is_positive: boolean;
  is_test: boolean;
  origin: 'internal' | 'cx';
  environment: string;
  status: string;
  created_at: Date;
  cx_ref: string | null;
  /** The diagnosis summary, when there is one: context for the AI same-issue check. */
  ai_summary: string | null;
  /** Problems this report is confirmed as an instance of. */
  kinds: { id: string; ref: string; title: string }[];
}

export interface StoredVerdict { submission_id: string; ref: string; verdict: 'same' | 'related' | 'different'; reason: string }

export interface SimilarityCheckRow {
  id: string;
  submission_id: string;
  verdicts: StoredVerdict[];
  model: string | null;
  cost_usd: string | null;
  created_by: string | null;
  created_at: Date;
}

const COLS = `s.id, s.ref, s.feature_key, s.issue_categories, s.feedback_text as text, s.firmware_version, s.app_version, s.platform,
  s.occurred_on::text as occurred_on, s.created_at, s.status, s.origin, s.environment, s.is_positive, s.is_test, s.cx_ref,
  coalesce(s.ai_event_codes, '{}') as event_codes, coalesce(d.tags, '{}') as tags, left(d.summary, 400) as ai_summary,
  coalesce((select json_agg(json_build_object('id', lk.id, 'ref', lk.ref, 'title', lk.title) order by lk.ref)
              from luna_feedback.submission_issue_kinds lsk
              join luna_feedback.issue_kinds lk on lk.id = lsk.kind_id
             where lsk.submission_id = s.id and lsk.state = 'linked'), '[]'::json) as kinds`;

const FROM = `from luna_feedback.submissions s left join luna_feedback.diagnoses d on d.submission_id = s.id`;

/** How far apart (by the day the problem happened) two reports can be and still be compared. */
const WINDOW_DAYS = 90;
/** Upper bound on reports scored per request; the matcher is cheap, this keeps the query cheap too. */
const POOL_LIMIT = 1500;

export class SimilarRepo {
  constructor(private readonly db: Db) {}

  async one(id: string): Promise<ReportForMatch | undefined> {
    const r = await this.db.query<ReportForMatch>(`select ${COLS} ${FROM} where s.id = $1`, [id]);
    return r.rows[0];
  }

  /** Which of these ids exist, so a bulk link can say exactly which ones it could not find. */
  async existing(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await this.db.query<{ id: string }>(`select id from luna_feedback.submissions where id = any($1::uuid[])`, [ids]);
    return new Set(r.rows.map((x) => x.id));
  }

  /** Issues near `source` in time, real or test like it, closest first. */
  async pool(source: { id: string; is_test: boolean; occurred_on: string }): Promise<ReportForMatch[]> {
    const r = await this.db.query<ReportForMatch>(
      `select ${COLS} ${FROM}
        where not s.is_positive and s.is_test = $1 and s.id <> $2
          and s.occurred_on between $3::date - $4::int and $3::date + $4::int
        order by abs(s.occurred_on - $3::date), s.created_at desc
        limit $5`,
      [source.is_test, source.id, source.occurred_on, WINDOW_DAYS, POOL_LIMIT],
    );
    return r.rows;
  }

  /** The confirmed reports of one problem, newest first. `isTest` null means real and test alike. */
  async members(kindId: string, isTest: boolean | null, limit = 50): Promise<ReportForMatch[]> {
    const r = await this.db.query<ReportForMatch>(
      `select ${COLS} ${FROM}
         join luna_feedback.submission_issue_kinds sk on sk.submission_id = s.id
        where sk.kind_id = $1 and sk.state = 'linked' and ($2::boolean is null or s.is_test = $2)
        order by s.created_at desc limit $3`,
      [kindId, isTest, limit],
    );
    return r.rows;
  }

  /**
   * Issues from around the time a problem has been happening (its reports' dates, widened by the
   * usual window) that are not yet linked to it, nor rejected from it.
   */
  async candidatesForKind(kindId: string, isTest: boolean | null, span: { from: string; to: string }): Promise<ReportForMatch[]> {
    const r = await this.db.query<ReportForMatch>(
      `select ${COLS} ${FROM}
        where not s.is_positive and ($2::boolean is null or s.is_test = $2)
          and s.occurred_on between $3::date - $5::int and $4::date + $5::int
          and not exists (select 1 from luna_feedback.submission_issue_kinds x
                           where x.submission_id = s.id and x.kind_id = $1 and x.state in ('linked', 'rejected'))
        order by s.created_at desc limit $6`,
      [kindId, isTest, span.from, span.to, WINDOW_DAYS, POOL_LIMIT],
    );
    return r.rows;
  }

  /**
   * Open problems with their most recent confirmed reports, for matching a new report against.
   * Problems this report already has any link row with (including a rejection) are left out.
   */
  async openKindMembers(submissionId: string, isTest: boolean, perKind = 20): Promise<(ReportForMatch & { kind_id: string; kind_ref: string; kind_title: string })[]> {
    const r = await this.db.query<ReportForMatch & { kind_id: string; kind_ref: string; kind_title: string }>(
      `select k.id as kind_id, k.ref as kind_ref, k.title as kind_title, m.*
         from luna_feedback.issue_kinds k
         cross join lateral (
           select ${COLS} ${FROM}
             join luna_feedback.submission_issue_kinds sk on sk.submission_id = s.id
            where sk.kind_id = k.id and sk.state = 'linked' and s.is_test = $2 and s.id <> $1
            order by s.created_at desc limit $3
         ) m
        where not k.is_archived and k.status in ('open', 'watching')
          and not exists (select 1 from luna_feedback.submission_issue_kinds x where x.kind_id = k.id and x.submission_id = $1)`,
      [submissionId, isTest, perKind],
    );
    return r.rows;
  }

  async saveCheck(c: { submission_id: string; verdicts: StoredVerdict[]; model: string | null; prompt_tokens: number | null; completion_tokens: number | null; cost_usd: number | null; created_by: string | null }): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.similarity_checks (submission_id, verdicts, model, prompt_tokens, completion_tokens, cost_usd, created_by)
       values ($1, $2::jsonb, $3, $4, $5, $6, $7)`,
      [c.submission_id, JSON.stringify(c.verdicts), c.model, c.prompt_tokens, c.completion_tokens, c.cost_usd, c.created_by],
    );
  }

  async latestCheck(submissionId: string): Promise<SimilarityCheckRow | undefined> {
    const r = await this.db.query<SimilarityCheckRow>(
      `select id, submission_id, verdicts, model, cost_usd::text as cost_usd, created_by, created_at
         from luna_feedback.similarity_checks where submission_id = $1 order by created_at desc limit 1`,
      [submissionId],
    );
    return r.rows[0];
  }
}
