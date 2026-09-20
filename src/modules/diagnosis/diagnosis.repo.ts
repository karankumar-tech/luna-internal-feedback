import type { Db } from '../../db/pool.js';

export type DiagnosisStatus = 'pending' | 'running' | 'waiting_logs' | 'done' | 'no_logs' | 'failed';

export interface DiagnosisRow {
  id: string;
  submission_id: string;
  status: DiagnosisStatus;
  root_cause_side: string | null;
  confidence: string | null; // numeric comes back as string
  severity: string | null;
  tags: string[];
  reproducible: string | null;
  summary: string | null;
  evidence: unknown[];
  suggested_fix: string | null;
  questions_for_tester: string[];
  /** Catalog ids the verdict cited, already validated against the built catalog. */
  event_codes: string[];
  log_device: Record<string, unknown> | null;
  log_files: Record<string, string[]>;
  log_window_from: Date | null;
  log_window_to: Date | null;
  log_excerpt: string | null;
  log_excerpt_lines: number;
  log_coverage: string | null;
  fw_version_seen: string | null;
  app_version_seen: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: string | null;
  duration_ms: number | null;
  trigger: string | null;
  error: string | null;
  review_verdict: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  submission_id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  run_after: Date;
  started_at: Date | null;
  last_error: string | null;
}

export interface RunRow {
  id: string; submission_id: string; status: string; trigger: string; model: string | null;
  prompt_tokens: number | null; completion_tokens: number | null; cost_usd: string | null; duration_ms: number | null;
  error: string | null; verdict_snapshot: unknown; created_at: Date;
}

const D_COLS = `id, submission_id, status, root_cause_side, confidence, severity, tags, reproducible, summary, evidence,
  suggested_fix, questions_for_tester, event_codes, log_device, log_files, log_window_from, log_window_to, log_excerpt, log_excerpt_lines,
  log_coverage, fw_version_seen, app_version_seen, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, trigger,
  error, review_verdict, review_note, reviewed_by, reviewed_at, created_at, updated_at`;

export class DiagnosisRepo {
  constructor(private readonly db: Db) {}

  async get(submissionId: string): Promise<DiagnosisRow | undefined> {
    const r = await this.db.query<DiagnosisRow>(`select ${D_COLS} from luna_feedback.diagnoses where submission_id = $1`, [submissionId]);
    return r.rows[0];
  }

  /** Create-or-reset the diagnosis row and queue a job. */
  async enqueue(submissionId: string, runAfter: Date = new Date()): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.diagnoses (submission_id, status) values ($1, 'pending')
       on conflict (submission_id) do update set status = 'pending', error = null`,
      [submissionId],
    );
    await this.db.query(
      `insert into luna_feedback.diagnosis_jobs (submission_id, state, run_after) values ($1, 'queued', $2)
       on conflict (submission_id) do update set state = 'queued', run_after = $2, last_error = null, started_at = null`,
      [submissionId, runAfter],
    );
    await this.db.query(`update luna_feedback.submissions set ai_status = 'pending' where id = $1`, [submissionId]);
  }

  /** Atomically claim a job: queued & due, or running but stale (worker died). Returns false when someone else holds it. */
  async claim(submissionId: string, staleMs = 6 * 60_000): Promise<JobRow | null> {
    const r = await this.db.query<JobRow>(
      `update luna_feedback.diagnosis_jobs
          set state = 'running', started_at = now(), attempts = attempts + 1
        where submission_id = $1
          and (state in ('queued', 'failed') or (state = 'running' and started_at < now() - ($2::int * interval '1 millisecond')))
        returning submission_id, state, attempts, run_after, started_at, last_error`,
      [submissionId, staleMs],
    );
    return r.rows[0] ?? null;
  }

  async ensureJob(submissionId: string): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.diagnosis_jobs (submission_id, state) values ($1, 'queued') on conflict (submission_id) do nothing`,
      [submissionId],
    );
  }

  async finishJob(submissionId: string, state: 'done' | 'failed' | 'queued', opts: { error?: string | null; runAfter?: Date } = {}): Promise<void> {
    await this.db.query(
      `update luna_feedback.diagnosis_jobs set state = $2, last_error = $3, run_after = coalesce($4, run_after), started_at = null where submission_id = $1`,
      [submissionId, state, opts.error ?? null, opts.runAfter ?? null],
    );
  }

  /** Queue recent negative submissions that were never diagnosed (e.g. arrived before diagnosis was enabled). */
  async enqueueMissing(limit = 20, days = 14): Promise<number> {
    const r = await this.db.query<{ id: string }>(
      `insert into luna_feedback.diagnosis_jobs (submission_id, state)
       select s.id, 'queued' from luna_feedback.submissions s
        where not s.is_positive
          and s.created_at > now() - ($2::int * interval '1 day')
          and not exists (select 1 from luna_feedback.diagnoses d where d.submission_id = s.id)
          and not exists (select 1 from luna_feedback.diagnosis_jobs j where j.submission_id = s.id)
        order by s.created_at desc limit $1
       returning submission_id as id`,
      [limit, days],
    );
    for (const row of r.rows) {
      await this.db.query(`insert into luna_feedback.diagnoses (submission_id, status) values ($1, 'pending') on conflict (submission_id) do nothing`, [row.id]);
      await this.db.query(`update luna_feedback.submissions set ai_status = 'pending' where id = $1 and ai_status is null`, [row.id]);
    }
    return r.rowCount ?? 0;
  }

  /** Jobs that are due: queued and run_after passed, or running but stale. Oldest first. */
  async dueJobs(limit: number, maxAttempts: number, staleMs = 6 * 60_000): Promise<JobRow[]> {
    const r = await this.db.query<JobRow>(
      `select submission_id, state, attempts, run_after, started_at, last_error
         from luna_feedback.diagnosis_jobs
        where attempts < $2
          and ((state = 'queued' and run_after <= now()) or (state = 'running' and started_at < now() - ($3::int * interval '1 millisecond')))
        order by run_after asc
        limit $1`,
      [limit, maxAttempts, staleMs],
    );
    return r.rows;
  }

  async setStatus(submissionId: string, status: DiagnosisStatus, patch: Partial<Record<string, unknown>> = {}): Promise<void> {
    const sets: string[] = ['status = $2'];
    const vals: unknown[] = [submissionId, status];
    for (const [k, v] of Object.entries(patch)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    await this.db.query(`update luna_feedback.diagnoses set ${sets.join(', ')} where submission_id = $1`, vals);
    const done = status === 'done' || status === 'no_logs';
    await this.db.query(
      `update luna_feedback.submissions
          set ai_status = $2,
              ai_side = case when $3 then coalesce($4, ai_side) else ai_side end,
              ai_severity = case when $3 then coalesce($5, ai_severity) else ai_severity end,
              ai_event_codes = case when $3 then coalesce($6::text[], ai_event_codes) else ai_event_codes end,
              ai_checked_at = case when $3 then now() else ai_checked_at end
        where id = $1`,
      [
        submissionId, status, done,
        (patch.root_cause_side as string | undefined) ?? null,
        (patch.severity as string | undefined) ?? null,
        (patch.event_codes as string[] | undefined) ?? null,
      ],
    );
  }

  async addRun(run: Omit<RunRow, 'id' | 'created_at' | 'cost_usd'> & { cost_usd: number | null }): Promise<void> {
    await this.db.query(
      `insert into luna_feedback.diagnosis_runs (submission_id, status, trigger, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, error, verdict_snapshot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [run.submission_id, run.status, run.trigger, run.model, run.prompt_tokens, run.completion_tokens, run.cost_usd, run.duration_ms, run.error, JSON.stringify(run.verdict_snapshot ?? null)],
    );
  }

  async runs(submissionId: string): Promise<RunRow[]> {
    const r = await this.db.query<RunRow>(`select * from luna_feedback.diagnosis_runs where submission_id = $1 order by created_at desc limit 20`, [submissionId]);
    return r.rows;
  }

  async review(submissionId: string, verdict: string, note: string | null, reviewer: string | null): Promise<DiagnosisRow | undefined> {
    const r = await this.db.query<DiagnosisRow>(
      `update luna_feedback.diagnoses set review_verdict = $2, review_note = $3, reviewed_by = $4, reviewed_at = now()
        where submission_id = $1 returning ${D_COLS}`,
      [submissionId, verdict, note, reviewer],
    );
    return r.rows[0];
  }

  /** Spend since the given instant, for the daily budget guard. */
  async spendSince(since: Date): Promise<number> {
    const r = await this.db.query<{ usd: string }>(`select coalesce(sum(cost_usd), 0)::text as usd from luna_feedback.diagnosis_runs where created_at >= $1`, [since]);
    return Number(r.rows[0]?.usd ?? 0);
  }

  async summary(): Promise<{ queued: number; running: number; waiting: number; failed: number; done: number; no_logs: number; spend_today: number; spend_month: number; runs_today: number }> {
    const [jobs, statuses, spend] = await Promise.all([
      this.db.query<{ state: string; n: number }>(`select state, count(*)::int as n from luna_feedback.diagnosis_jobs group by state`),
      this.db.query<{ status: string; n: number }>(`select status, count(*)::int as n from luna_feedback.diagnoses group by status`),
      this.db.query<{ today: string; month: string; runs_today: number }>(
        `select coalesce(sum(cost_usd) filter (where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'), 0)::text as today,
                coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'), 0)::text as month,
                count(*) filter (where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')::int as runs_today
           from luna_feedback.diagnosis_runs`),
    ]);
    const j = Object.fromEntries(jobs.rows.map((r) => [r.state, r.n]));
    const s = Object.fromEntries(statuses.rows.map((r) => [r.status, r.n]));
    return {
      queued: j.queued ?? 0, running: j.running ?? 0, failed: j.failed ?? 0,
      waiting: s.waiting_logs ?? 0, done: s.done ?? 0, no_logs: s.no_logs ?? 0,
      spend_today: Number(spend.rows[0]?.today ?? 0), spend_month: Number(spend.rows[0]?.month ?? 0), runs_today: spend.rows[0]?.runs_today ?? 0,
    };
  }

  /** Aggregates for the diagnosis overview page, over submissions with occurred_on in [from, to]. Excludes test data unless asked. */
  async overview(from: string, to: string, includeTest: boolean): Promise<Record<string, unknown>> {
    const where = `where s.occurred_on >= $1 and s.occurred_on <= $2 and not s.is_positive ${includeTest ? '' : 'and not s.is_test'}`;
    const vals = [from, to];
    const q = <T extends Record<string, any>>(sql: string) => this.db.query<T>(sql, vals);
    const [totals, sideByFeature, fwVersions, appVersions, tags, confidence, review, costByDay, attention, devices] = await Promise.all([
      q<{ issues: number; diagnosed: number; no_logs: number; waiting: number; failed: number; unchecked: number; reviewed: number; agree: number; disagree: number; avg_conf: string | null; cost: string; avg_ms: string | null }>(
        `select count(*)::int as issues,
                count(*) filter (where d.status = 'done')::int as diagnosed,
                count(*) filter (where d.status = 'no_logs')::int as no_logs,
                count(*) filter (where d.status in ('pending','running','waiting_logs'))::int as waiting,
                count(*) filter (where d.status = 'failed')::int as failed,
                count(*) filter (where d.submission_id is null)::int as unchecked,
                count(*) filter (where d.review_verdict is not null)::int as reviewed,
                count(*) filter (where d.review_verdict = 'agree')::int as agree,
                count(*) filter (where d.review_verdict = 'disagree')::int as disagree,
                avg(d.confidence) filter (where d.status = 'done')::text as avg_conf,
                coalesce(sum(d.cost_usd), 0)::text as cost,
                avg(d.duration_ms) filter (where d.status = 'done')::text as avg_ms
           from luna_feedback.submissions s left join luna_feedback.diagnoses d on d.submission_id = s.id ${where}`),
      q<{ feature_key: string; label: string; side: string; count: number }>(
        `select s.feature_key, f.label, d.root_cause_side as side, count(*)::int as count
           from luna_feedback.submissions s join luna_feedback.diagnoses d on d.submission_id = s.id join luna_feedback.features f on f.key = s.feature_key
          ${where} and d.root_cause_side is not null group by s.feature_key, f.label, f.sort_order, d.root_cause_side order by f.sort_order, count desc`),
      q<{ version: string; issues: number; firmware_side: number; high: number }>(
        `select coalesce(d.fw_version_seen, s.firmware_version) as version, count(*)::int as issues,
                count(*) filter (where d.root_cause_side = 'firmware')::int as firmware_side,
                count(*) filter (where d.severity in ('high','critical'))::int as high
           from luna_feedback.submissions s left join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where} and coalesce(d.fw_version_seen, s.firmware_version) is not null group by 1 order by issues desc limit 10`),
      q<{ version: string; platform: string | null; issues: number; app_side: number }>(
        `select coalesce(d.app_version_seen, s.app_version) as version, s.platform, count(*)::int as issues,
                count(*) filter (where d.root_cause_side in ('app','sdk'))::int as app_side
           from luna_feedback.submissions s left join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where} and coalesce(d.app_version_seen, s.app_version) is not null group by 1, 2 order by issues desc limit 10`),
      q<{ tag: string; count: number; features: string[] }>(
        `select t.tag, count(*)::int as count, array_agg(distinct s.feature_key) as features
           from luna_feedback.submissions s join luna_feedback.diagnoses d on d.submission_id = s.id cross join lateral unnest(d.tags) as t(tag)
          ${where} group by t.tag order by count desc limit 15`),
      q<{ bucket: number; count: number }>(
        `select least(floor(d.confidence * 5), 4)::int as bucket, count(*)::int as count
           from luna_feedback.submissions s join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where} and d.status = 'done' group by 1 order by 1`),
      q<{ side: string; agree: number; disagree: number; unsure: number }>(
        `select d.root_cause_side as side,
                count(*) filter (where d.review_verdict = 'agree')::int as agree,
                count(*) filter (where d.review_verdict = 'disagree')::int as disagree,
                count(*) filter (where d.review_verdict = 'unsure')::int as unsure
           from luna_feedback.submissions s join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where} and d.review_verdict is not null group by 1 order by 1`),
      q<{ day: string; runs: number; cost: string }>(
        `select (r.created_at at time zone 'Asia/Kolkata')::date::text as day, count(*)::int as runs, coalesce(sum(r.cost_usd), 0)::text as cost
           from luna_feedback.diagnosis_runs r join luna_feedback.submissions s on s.id = r.submission_id
          ${where} group by 1 order by 1 desc limit 30`),
      q<{ id: string; feature_key: string; occurred_on: string; user_id: string; status: string; side: string | null; severity: string | null; confidence: string | null; summary: string | null; review_verdict: string | null; is_test: boolean }>(
        `select s.id, s.feature_key, s.occurred_on::text as occurred_on, s.user_id, d.status, d.root_cause_side as side, d.severity, d.confidence::text as confidence, d.summary, d.review_verdict, s.is_test
           from luna_feedback.submissions s join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where} and (d.root_cause_side = 'insufficient_logs' or d.review_verdict = 'disagree' or d.severity = 'critical' or d.status = 'failed')
          order by case when d.severity = 'critical' then 0 when d.review_verdict = 'disagree' then 1 else 2 end, s.created_at desc limit 20`),
      q<{ model: string; platform: string | null; issues: number }>(
        `select coalesce(d.log_device->>'device_model', 'unknown') as model, coalesce(d.log_device->>'platform', s.platform) as platform, count(*)::int as issues
           from luna_feedback.submissions s join luna_feedback.diagnoses d on d.submission_id = s.id
          ${where} and d.status = 'done' group by 1, 2 order by issues desc limit 10`),
    ]);
    const t = totals.rows[0]!;
    return {
      range: { from, to, include_test: includeTest },
      totals: { ...t, avg_conf: t.avg_conf === null ? null : Number(t.avg_conf), cost: Number(t.cost), avg_ms: t.avg_ms === null ? null : Number(t.avg_ms) },
      side_by_feature: sideByFeature.rows,
      firmware_versions: fwVersions.rows,
      app_versions: appVersions.rows,
      tags: tags.rows,
      confidence_hist: confidence.rows,
      review_by_side: review.rows,
      cost_by_day: costByDay.rows.map((r) => ({ ...r, cost: Number(r.cost) })),
      attention: attention.rows.map((r) => ({ ...r, confidence: r.confidence === null ? null : Number(r.confidence), user_id: Number(r.user_id) })),
      devices: devices.rows,
    };
  }
}
