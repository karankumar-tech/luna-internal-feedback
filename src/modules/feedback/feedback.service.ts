import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { formatInZone } from '../../lib/time.js';
import { buildSubmissionValidator, zodIssues } from '../../schema/buildValidator.js';
import { SCHEMA_VERSION, isFeatureKey } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import type { FeedbackRepo, SubmissionRow, ListFilters, StatsFilters } from './feedback.repo.js';

export interface SubmissionDto extends Omit<SubmissionRow, 'created_at' | 'user_id' | 'idempotency_key'> {
  user_id: number;
  created_at: string;      // ISO 8601 UTC
  created_at_ist: string;  // "YYYY-MM-DD HH:mm:ss +05:30"
}

export class FeedbackService {
  constructor(
    private readonly feedback: FeedbackRepo,
    private readonly categories: CategoriesRepo,
    private readonly timeZone: string,
  ) {}

  toDto(row: SubmissionRow): SubmissionDto {
    const { idempotency_key: _omit, ...rest } = row;
    return {
      ...rest,
      user_id: Number(row.user_id),
      created_at: row.created_at.toISOString(),
      created_at_ist: formatInZone(row.created_at, this.timeZone),
    };
  }

  async submit(featureKey: string, body: unknown, idempotencyKey: string | null) {
    if (!isFeatureKey(featureKey)) throw AppError.notFound(`Unknown feature "${featureKey}"`);
    const feature = await this.categories.feature(featureKey);
    if (!feature || !feature.is_active) throw AppError.notFound(`Feature "${featureKey}" is not accepting feedback`);

    const categoryKeys = await this.categories.activeKeysFor(featureKey);
    const validator = buildSubmissionValidator(featureKey, { categoryKeys, timeZone: this.timeZone });
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
      occurred_on: v.occurred_on as string,
      user_id: v.user_id as number,
      email: v.email as string,
      issue_categories: v.issue_categories as string[],
      feedback_text: (v.feedback_text as string | null | undefined) ?? null,
      device_serial: (v.device_serial as string | null | undefined) || null,
      details,
      client,
      idempotency_key: idempotencyKey,
      schema_version: SCHEMA_VERSION,
      is_test: v.is_test === true,
    });
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

  async countTestData() {
    return this.feedback.countTestData();
  }

  async deleteTestData() {
    return this.feedback.deleteTestData();
  }
}
