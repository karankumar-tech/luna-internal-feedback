import type { FastifyBaseLogger } from 'fastify';
import { DiagnosisRepo, type DiagnosisRow, type DiagnosisStatus } from './diagnosis.repo.js';
import type { FeedbackRepo, SubmissionRow } from '../feedback/feedback.repo.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import { LogsClient } from './logs/client.js';
import { pickAllSources, pickEntry } from './logs/select.js';
import { fetchLogFile } from './logs/fetch.js';
import { parseFetched, istToEpoch } from './logs/parse.js';
import type { LogDeviceEntry, LogFileRef, LogSource, ParsedFile } from './logs/types.js';
import { buildExcerpt } from './extract.js';
import { OpenRouterClient, estimateCost } from './ai/openrouter.js';
import { buildMessages } from './ai/prompt.js';
import { VERDICT_JSON_SCHEMA, VerdictSchema, type Verdict } from './ai/schema.js';
import { FEATURE_DEFINITIONS, type FeatureKey } from '../../schema/registry.js';
import { AppError } from '../../lib/errors.js';
import { todayInZone } from '../../lib/time.js';
import { runInBackground } from './background.js';

export interface DiagnosisConfig {
  model: string;
  auto: boolean;
  dailyBudgetUsd: number;
  timeZone: string;
  maxAttempts: number;
  /** IST hour after which the day's logs are expected to have synced (iOS syncs after ~20:00). */
  syncHourIst: number;
}

export interface DiagnosisDeps {
  repo: DiagnosisRepo;
  feedback: FeedbackRepo;
  categories: CategoriesRepo;
  logs: LogsClient | null;
  ai: OpenRouterClient | null;
  config: DiagnosisConfig;
  log: FastifyBaseLogger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface RunOutcome {
  submission_id: string;
  status: DiagnosisStatus | 'skipped';
  reason?: string;
  diagnosis?: DiagnosisDto;
}

export interface DiagnosisDto extends Omit<DiagnosisRow, 'confidence' | 'cost_usd' | 'log_window_from' | 'log_window_to' | 'reviewed_at' | 'created_at' | 'updated_at'> {
  confidence: number | null;
  cost_usd: number | null;
  log_window_from: string | null;
  log_window_to: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toDiagnosisDto(r: DiagnosisRow): DiagnosisDto {
  return {
    ...r,
    confidence: r.confidence === null ? null : Number(r.confidence),
    cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
    log_window_from: r.log_window_from ? new Date(r.log_window_from).toISOString() : null,
    log_window_to: r.log_window_to ? new Date(r.log_window_to).toISOString() : null,
    reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const BLE_MEMBER = /BLE_/i;

export class DiagnosisService {
  constructor(private readonly d: DiagnosisDeps) {}

  get enabled(): boolean { return !!(this.d.logs && this.d.ai); }
  private now(): Date { return this.d.now ? this.d.now() : new Date(); }

  /** Called from the submit path for negative feedback. Queues and starts the run after the response. */
  async enqueueAndRun(submissionId: string, log: FastifyBaseLogger): Promise<void> {
    if (!this.enabled || !this.d.config.auto) return;
    await this.d.repo.enqueue(submissionId);
    await runInBackground(() => this.run(submissionId, 'auto'), log, `diagnose ${submissionId}`);
  }

  /** Process due jobs sequentially (each ~5–20 s). Used by the dashboard sweep and the nightly cron. */
  async runPending(limit = 5): Promise<RunOutcome[]> {
    if (!this.enabled) return [];
    await this.d.repo.enqueueMissing(limit);
    const jobs = await this.d.repo.dueJobs(limit, this.d.config.maxAttempts);
    const out: RunOutcome[] = [];
    for (const j of jobs) out.push(await this.run(j.submission_id, 'auto'));
    return out;
  }

  /**
   * Full pipeline for one submission. Safe to call concurrently: the job row is claimed atomically.
   * Manual runs force a re-run even when a diagnosis already exists.
   */
  async run(submissionId: string, trigger: 'auto' | 'manual'): Promise<RunOutcome> {
    if (!this.enabled) throw AppError.validation([{ path: 'diagnosis', message: 'AI diagnosis is not configured (LUNA_LOGS_APIKEY / OPEN_ROUTER_KEY)' }], 'Diagnosis unavailable');
    const repo = this.d.repo;
    const sub = await this.d.feedback.byId(submissionId);
    if (!sub) throw AppError.notFound('Submission not found');

    if (trigger === 'manual') await repo.enqueue(submissionId);
    else await repo.ensureJob(submissionId);
    const job = await repo.claim(submissionId);
    if (!job) return { submission_id: submissionId, status: 'skipped', reason: 'already running' };

    const started = Date.now();
    await repo.setStatus(submissionId, 'running', { trigger, error: null });

    try {
      // Budget guard (auto only): park until tomorrow when today's spend is over the cap.
      if (trigger === 'auto' && this.d.config.dailyBudgetUsd > 0) {
        const spent = await repo.spendSince(this.istDayStart(this.now()));
        if (spent >= this.d.config.dailyBudgetUsd) {
          const tomorrow = new Date(this.istDayStart(this.now()).getTime() + 86_400_000 + 60_000);
          await repo.setStatus(submissionId, 'pending', { error: 'daily budget reached; retrying tomorrow' });
          await repo.finishJob(submissionId, 'queued', { error: 'daily budget reached', runAfter: tomorrow });
          return { submission_id: submissionId, status: 'pending', reason: 'daily budget reached' };
        }
      }

      const outcome = await this.diagnose(sub, trigger, started);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.d.log.error({ err, submissionId }, 'diagnosis failed');
      await repo.addRun({ submission_id: submissionId, status: 'failed', trigger, model: this.d.config.model, prompt_tokens: null, completion_tokens: null, cost_usd: null, duration_ms: Date.now() - started, error: message.slice(0, 1000), verdict_snapshot: null });
      const retry = job.attempts < this.d.config.maxAttempts;
      await repo.finishJob(submissionId, retry ? 'queued' : 'failed', { error: message.slice(0, 500), runAfter: new Date(this.now().getTime() + 15 * 60_000) });
      await repo.setStatus(submissionId, 'failed', { error: message.slice(0, 1000), duration_ms: Date.now() - started, trigger });
      const row = await repo.get(submissionId);
      return { submission_id: submissionId, status: 'failed', reason: message, diagnosis: row ? toDiagnosisDto(row) : undefined };
    }
  }

  // ---------------------------------------------------------------------------

  private istDayStart(now: Date): Date {
    const day = todayInZone(this.d.config.timeZone, now);
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return new Date(istToEpoch(y, m, d, 0, 0, 0));
  }

  /**
   * Logs upload on a schedule (iOS after ~20:00 IST). For an issue that happened today or yesterday,
   * a missing same-day file is "not yet", not "never". Returns the time to try again, or null when
   * waiting is pointless (the issue is old enough that the logs would have arrived by now).
   */
  private nextLogCheck(occurredOn: string): Date | null {
    const now = this.now();
    const [y, m, d] = occurredOn.split('-').map(Number) as [number, number, number];
    const syncAt = new Date(istToEpoch(y, m, d, this.d.config.syncHourIst, 30, 0));
    const giveUpAt = new Date(istToEpoch(y, m, d, 23, 0, 0) + 2 * 86_400_000); // two days after the issue day
    if (now >= giveUpAt) return null;
    if (now < syncAt) return syncAt;
    return new Date(Math.min(now.getTime() + 3 * 3_600_000, giveUpAt.getTime()));
  }

  private async park(submissionId: string, trigger: 'auto' | 'manual', started: number, reason: string, patch: Record<string, unknown>, occurredOn: string): Promise<RunOutcome> {
    const repo = this.d.repo;
    const next = this.nextLogCheck(occurredOn);
    if (next) {
      await repo.addRun({ submission_id: submissionId, status: 'waiting_logs', trigger, model: null, prompt_tokens: null, completion_tokens: null, cost_usd: 0, duration_ms: Date.now() - started, error: reason, verdict_snapshot: null });
      await repo.finishJob(submissionId, 'queued', { error: reason, runAfter: next });
      await repo.setStatus(submissionId, 'waiting_logs', { ...patch, error: reason, duration_ms: Date.now() - started, trigger });
      const row = await repo.get(submissionId);
      return { submission_id: submissionId, status: 'waiting_logs', reason: `${reason}; next check ${next.toISOString()}`, diagnosis: row ? toDiagnosisDto(row) : undefined };
    }
    await repo.addRun({ submission_id: submissionId, status: 'no_logs', trigger, model: null, prompt_tokens: null, completion_tokens: null, cost_usd: 0, duration_ms: Date.now() - started, error: reason, verdict_snapshot: null });
    await repo.finishJob(submissionId, 'done');
    await repo.setStatus(submissionId, 'no_logs', { ...patch, error: reason, duration_ms: Date.now() - started, trigger });
    const row = await repo.get(submissionId);
    return { submission_id: submissionId, status: 'no_logs', reason, diagnosis: row ? toDiagnosisDto(row) : undefined };
  }

  private async diagnose(sub: SubmissionRow, trigger: 'auto' | 'manual', started: number): Promise<RunOutcome> {
    const repo = this.d.repo;
    const logs = this.d.logs!;
    const ai = this.d.ai!;

    // 1. lookup: serial first, email fallback
    let entries: LogDeviceEntry[] = [];
    let lookedUpBy = '';
    if (sub.device_serial) { entries = await logs.listBySerial(sub.device_serial); lookedUpBy = `serial ${sub.device_serial}`; }
    if (entries.length === 0) { entries = await logs.listByEmail(sub.email); lookedUpBy = lookedUpBy ? `${lookedUpBy}, then email` : 'email'; }
    const entry = pickEntry(entries, { platform: sub.platform, occurredOn: sub.occurred_on });
    if (!entry) return this.park(sub.id, trigger, started, `no device found in logging service (looked up by ${lookedUpBy})`, {}, sub.occurred_on);

    // 2. select files
    const picked = pickAllSources(entry, sub.occurred_on);
    const allPicked = [...picked.app, ...picked.ring, ...picked.firmware];
    const logFiles: Record<LogSource, string[]> = { app: picked.app.map((f) => f.url), ring: picked.ring.map((f) => f.url), firmware: picked.firmware.map((f) => f.url) };
    const deviceMeta = { ...entry, files: undefined, file_counts: { app: entry.files.app.length, ring: entry.files.ring.length, firmware: entry.files.firmware.length } };
    const hasOnOrAfter = allPicked.some((f) => f.date && f.date >= sub.occurred_on);
    if (allPicked.length === 0) return this.park(sub.id, trigger, started, 'device found but no log files near the issue day', { log_device: deviceMeta }, sub.occurred_on);
    if (!hasOnOrAfter && this.nextLogCheck(sub.occurred_on)) return this.park(sub.id, trigger, started, 'only files from before the issue day so far (logs sync later in the day)', { log_device: deviceMeta, log_files: logFiles }, sub.occurred_on);

    // 3. download + parse (per-file failures are logged, not fatal)
    const dates = [sub.occurred_on, shiftDay(sub.occurred_on, -1), shiftDay(sub.occurred_on, 1)];
    const parsed: ParsedFile[] = [];
    const usedFiles: Record<LogSource, string[]> = { app: [], ring: [], firmware: [] };
    for (const ref of allPicked) {
      try {
        const fetched = await fetchLogFile(ref, { fetchImpl: this.d.fetchImpl, memberDates: dates, skipMember: (name) => BLE_MEMBER.test(name) && !name.includes(sub.occurred_on) });
        const pf = parseFetched(ref, fetched.parts, fetched.bytes);
        parsed.push(pf);
        usedFiles[ref.source].push(ref.url);
      } catch (err) {
        this.d.log.warn({ err, url: ref.url }, 'log file skipped');
      }
    }

    // 4. extract
    const feature = FEATURE_DEFINITIONS[sub.feature_key as FeatureKey];
    const excerpt = buildExcerpt(parsed, { feature: sub.feature_key, occurredOn: sub.occurred_on, details: sub.details, fwVersion: entry.fv, appVersion: entry.version_name });
    const windowPatch = { log_window_from: new Date(excerpt.window.from), log_window_to: new Date(excerpt.window.to), log_coverage: excerpt.coverage, log_device: deviceMeta, log_files: usedFiles };
    if (excerpt.coverage === 'none') return this.park(sub.id, trigger, started, 'log files downloaded but no parseable lines', windowPatch, sub.occurred_on);

    // 5. model
    const catLabels = new Map((await this.d.categories.listAll(sub.feature_key)).map((c) => [c.key, c.label]));
    const featureRow = await this.d.categories.feature(sub.feature_key);
    const messages = buildMessages({
      feature: { key: sub.feature_key, label: featureRow?.label ?? sub.feature_key },
      submission: {
        occurred_on: sub.occurred_on, is_positive: sub.is_positive,
        issue_categories: sub.issue_categories.map((k) => ({ key: k, label: catLabels.get(k) ?? k })),
        feedback_text: sub.feedback_text, details: sub.details,
        detailLabels: Object.fromEntries((feature?.fields ?? []).map((f) => [f.key, f.label])),
        platform: sub.platform, app_version: sub.app_version, firmware_version: sub.firmware_version, os_version: sub.os_version,
      },
      device: entry, excerpt: excerpt.excerpt, windowLabel: `${excerpt.window.label} (${new Date(excerpt.window.from + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(excerpt.window.to + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST)`,
      coverage: excerpt.coverage,
    });
    const completion = await ai.completeJson(messages, VERDICT_JSON_SCHEMA);
    let verdict: Verdict;
    try {
      const json = JSON.parse(completion.text);
      const v = VerdictSchema.safeParse(json);
      if (!v.success) throw new Error('model output failed validation: ' + v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      verdict = v.data;
    } catch (err) {
      throw new Error(`could not parse model output (${err instanceof Error ? err.message : String(err)}): ${completion.text.slice(0, 300)}`);
    }
    const cost = completion.costUsd ?? estimateCost(completion.model, completion.promptTokens, completion.completionTokens);
    const durationMs = Date.now() - started;

    // 6. persist (status flips last so readers never see 'done' with an unfinished job)
    const donePatch = {
      ...windowPatch,
      root_cause_side: verdict.root_cause_side, confidence: verdict.confidence, severity: verdict.severity, tags: verdict.tags,
      reproducible: verdict.reproducible, summary: verdict.summary, evidence: JSON.stringify(verdict.evidence), suggested_fix: verdict.suggested_fix,
      questions_for_tester: verdict.questions_for_tester, log_excerpt: excerpt.excerpt.slice(0, 32_000), log_excerpt_lines: excerpt.lineCount,
      fw_version_seen: verdict.fw_version_seen ?? entry.fv, app_version_seen: verdict.app_version_seen ?? entry.version_name,
      model: completion.model, prompt_tokens: completion.promptTokens, completion_tokens: completion.completionTokens, cost_usd: cost,
      duration_ms: durationMs, trigger, error: null,
    };
    await repo.addRun({ submission_id: sub.id, status: 'done', trigger, model: completion.model, prompt_tokens: completion.promptTokens, completion_tokens: completion.completionTokens, cost_usd: cost, duration_ms: durationMs, error: null, verdict_snapshot: verdict });
    await repo.finishJob(sub.id, 'done');
    await repo.setStatus(sub.id, 'done', donePatch);
    const row = await repo.get(sub.id);
    return { submission_id: sub.id, status: 'done', diagnosis: row ? toDiagnosisDto(row) : undefined };
  }

  async get(submissionId: string): Promise<DiagnosisDto | null> {
    const row = await this.d.repo.get(submissionId);
    return row ? toDiagnosisDto(row) : null;
  }

  async review(submissionId: string, verdict: 'agree' | 'disagree' | 'unsure', note: string | null, reviewer: string | null): Promise<DiagnosisDto> {
    const row = await this.d.repo.review(submissionId, verdict, note, reviewer);
    if (!row) throw AppError.notFound('No diagnosis for this submission yet');
    return toDiagnosisDto(row);
  }

  /** Raw lookup for the detail page: every file the logging service has for this tester. */
  async lookup(params: { serial_no?: string; email?: string }): Promise<LogDeviceEntry[]> {
    if (!this.d.logs) throw AppError.validation([{ path: 'logs', message: 'LUNA_LOGS_APIKEY not configured' }], 'Logs lookup unavailable');
    if (params.serial_no) return this.d.logs.listBySerial(params.serial_no);
    if (params.email) return this.d.logs.listByEmail(params.email);
    throw AppError.validation([{ path: 'serial_no', message: 'serial_no or email is required' }]);
  }
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export { type LogFileRef };
