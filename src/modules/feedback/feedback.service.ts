import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { formatInZone, todayInZone } from '../../lib/time.js';
import { buildSubmissionValidator, zodIssues } from '../../schema/buildValidator.js';
import { SCHEMA_VERSION, isFeatureKey } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import type { FeedbackRepo, SubmissionRow, ListFilters, StatsFilters, Screenshot, SubmissionStatus } from './feedback.repo.js';
import type { FastifyBaseLogger } from 'fastify';

/** Minimal hook so the feedback module does not depend on the diagnosis module directly. */
export interface DiagnosisHook { onNegativeSubmission(submissionId: string, log: FastifyBaseLogger): Promise<void> }

export interface SubmissionDto extends Omit<SubmissionRow, 'created_at' | 'user_id' | 'idempotency_key' | 'ai_checked_at' | 'status_changed_at' | 'jira_synced_at'> {
  user_id: number;
  created_at: string;      // ISO 8601 UTC
  created_at_ist: string;  // "YYYY-MM-DD HH:mm:ss +05:30"
  ai_checked_at: string | null;
  status_changed_at: string | null;
  jira_synced_at: string | null;
}

export class FeedbackService {
  private diagnosis: DiagnosisHook | null = null;
  /** Screenshot URL validator + cleanup, wired when ImageKit is configured. */
  private screenshots: { isOurUrl: (u: string) => boolean; maxCount: number; deleteFile: (id: string) => Promise<boolean> } | null = null;

  constructor(
    private readonly feedback: FeedbackRepo,
    private readonly categories: CategoriesRepo,
    private readonly timeZone: string,
  ) {}

  setDiagnosisHook(hook: DiagnosisHook | null) { this.diagnosis = hook; }
  setScreenshotSupport(s: { isOurUrl: (u: string) => boolean; maxCount: number; deleteFile: (id: string) => Promise<boolean> } | null) { this.screenshots = s; }

  toDto(row: SubmissionRow): SubmissionDto {
    const { idempotency_key: _omit, ...rest } = row;
    return {
      ...rest,
      user_id: Number(row.user_id),
      ai_checked_at: row.ai_checked_at ? new Date(row.ai_checked_at).toISOString() : null,
      status_changed_at: row.status_changed_at ? new Date(row.status_changed_at).toISOString() : null,
      jira_synced_at: row.jira_synced_at ? new Date(row.jira_synced_at).toISOString() : null,
      created_at: row.created_at.toISOString(),
      created_at_ist: formatInZone(row.created_at, this.timeZone),
    };
  }

  async submit(featureKey: string, body: unknown, idempotencyKey: string | null, log?: FastifyBaseLogger) {
    if (!isFeatureKey(featureKey)) throw AppError.notFound(`Unknown feature "${featureKey}"`);
    const feature = await this.categories.feature(featureKey);
    if (!feature || !feature.is_active) throw AppError.notFound(`Feature "${featureKey}" is not accepting feedback`);

    const categoryKeys = await this.categories.activeKeysFor(featureKey);
    const validator = buildSubmissionValidator(featureKey, {
      categoryKeys, timeZone: this.timeZone,
      isScreenshotUrl: this.screenshots ? this.screenshots.isOurUrl : undefined,
      maxScreenshots: this.screenshots?.maxCount,
    });
    const parsed = validator.safeParse(body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const v = parsed.data;

    const details: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.details ?? {})) if (val !== undefined && val !== null) details[k] = val;

    const client: Record<string, string | null> = {};
    for (const [k, val] of Object.entries(v.client ?? {})) if (typeof val === 'string' && val.length > 0) client[k] = val;

    const { row, created } = await this.feedback.insert({
      feature_key: featureKey,
      is_positive: v.is_positive as boolean,
      occurred_on: (v.occurred_on as string | null | undefined) ?? todayInZone(this.timeZone),
      user_id: v.user_id as number,
      email: v.email as string,
      issue_categories: (v.issue_categories as string[] | null | undefined) ?? [],
      feedback_text: (v.feedback_text as string | null | undefined) ?? null,
      device_serial: (v.device_serial as string | null | undefined) || null,
      screenshots: ((v.screenshots as Screenshot[] | null | undefined) ?? []).map((x) => ({
        file_id: x.file_id, url: x.url, thumbnail_url: x.thumbnail_url ?? null, name: x.name ?? null, width: x.width ?? null, height: x.height ?? null, size: x.size ?? null,
        upload_size: x.upload_size ?? null, original_width: x.original_width ?? null, original_height: x.original_height ?? null,
      })),
      details,
      client,
      idempotency_key: idempotencyKey,
      schema_version: SCHEMA_VERSION,
      is_test: v.is_test === true,
    });
    if (created && !row.is_positive && this.diagnosis && log) {
      // Queue + start after the response; never let diagnosis problems break the submit.
      try { await this.diagnosis.onNegativeSubmission(row.id, log); } catch (err) { log.error({ err }, 'could not queue diagnosis'); }
    }
    return { dto: this.toDto(row), created };
  }

  async get(id: string): Promise<SubmissionDto> {
    if (!z.string().uuid().safeParse(id).success) throw AppError.notFound('Submission not found');
    const row = await this.feedback.byId(id);
    if (!row) throw AppError.notFound('Submission not found');
    return this.toDto(row);
  }

  async list(filters: ListFilters) {
    const { rows, nextCursor } = await this.feedback.list(filters);
    return { items: rows.map((r) => this.toDto(r)), next_cursor: nextCursor };
  }

  async stats(filters: StatsFilters) {
    return this.feedback.stats(filters);
  }

  async setTestFlag(id: string, isTest: boolean): Promise<SubmissionDto> {
    if (!z.string().uuid().safeParse(id).success) throw AppError.notFound('Submission not found');
    const row = await this.feedback.setTestFlag(id, isTest);
    if (!row) throw AppError.notFound('Submission not found');
    return this.toDto(row);
  }

  async setStatus(id: string, status: SubmissionStatus, note: string | null, by: string | null): Promise<SubmissionDto> {
    if (!z.string().uuid().safeParse(id).success) throw AppError.notFound('Submission not found');
    const row = await this.feedback.setStatus(id, status, note, by);
    if (!row) throw AppError.notFound('Submission not found');
    return this.toDto(row);
  }

  async countTestData() {
    return this.feedback.countTestData();
  }

  async deleteTestData() {
    const { deleted, screenshotFileIds } = await this.feedback.deleteTestData();
    if (this.screenshots && screenshotFileIds.length) {
      // Best effort, sequential to respect ImageKit rate limits; failures are ignored.
      for (const id of screenshotFileIds) await this.screenshots.deleteFile(id);
    }
    return deleted;
  }
}
