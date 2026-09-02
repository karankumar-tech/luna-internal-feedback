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
  suggested_fix, questions_for_tester, log_device, log_files, log_window_from, log_window_to, log_excerpt, log_excerpt_lines,
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
              ai_checked_at = case when $3 then now() else ai_checked_at end
        where id = $1`,
      [submissionId, status, done, (patch.root_cause_side as string | undefined) ?? null, (patch.severity as string | undefined) ?? null],
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
}
