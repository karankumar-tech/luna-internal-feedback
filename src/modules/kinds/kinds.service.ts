import { AppError } from '../../lib/errors.js';
import { isKnownEventCode } from '../diagnosis/knowledge/catalog.js';
import {
  KindsRepo, normalizeTitle, slugify,
  type IssueKindRow, type KindLinkSource, type KindStatus,
} from './kinds.repo.js';
import type { CommonFilters } from '../feedback/feedback.repo.js';

export interface NewKind {
  title: string;
  key?: string;
  description?: string | null;
  feature_key?: string | null;
  tags?: string[];
  event_codes?: string[];
  severity?: string | null;
  status?: KindStatus;
}

export class KindsService {
  constructor(private readonly repo: KindsRepo) {}

  list(filters: Partial<CommonFilters> & { from?: string; to?: string; includeArchived?: boolean; status?: string }) {
    return this.repo.list(filters);
  }

  async get(id: string) {
    const kind = await this.repo.byId(id);
    if (!kind) throw AppError.notFound('Issue kind not found');
    return kind;
  }

  async detail(id: string, filters: Partial<CommonFilters> & { from?: string; to?: string }) {
    const kind = await this.get(id);
    const [withCounts, trend] = await Promise.all([
      this.repo.list({ ...filters, includeArchived: true }),
      this.repo.trend(id, filters),
    ]);
    const counts = withCounts.find((k) => k.id === id);
    return {
      ...kind,
      count: counts?.count ?? 0,
      users: counts?.users ?? 0,
      open_count: counts?.open_count ?? 0,
      ai_count: counts?.ai_count ?? 0,
      first_seen: counts?.first_seen ?? null,
      last_seen: counts?.last_seen ?? null,
      trend,
    };
  }

  async create(input: NewKind, by: string | null): Promise<IssueKindRow> {
    const title = input.title.trim();
    if (!title) throw AppError.validation([{ path: 'title', message: 'title is required' }]);

    const key = (input.key?.trim() || slugify(title));
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw AppError.validation([{ path: 'key', message: 'must be lower_snake_case and start with a letter' }]);
    }
    if (await this.repo.byKey(key)) {
      throw AppError.validation([{ path: 'key', message: `an issue kind with key "${key}" already exists` }], 'Duplicate issue kind');
    }
    const unknown = (input.event_codes ?? []).filter((c) => !isKnownEventCode(c));
    if (unknown.length) {
      throw AppError.validation([{ path: 'event_codes', message: `unknown event code(s): ${unknown.join(', ')}` }]);
    }

    return this.repo.create({
      key,
      title,
      description: input.description?.trim() || null,
      feature_key: input.feature_key ?? null,
      tags: input.tags ?? [],
      event_codes: (input.event_codes ?? []).map((c) => c.trim().toUpperCase()),
      severity: input.severity ?? null,
      status: input.status,
      created_by: by,
    });
  }

  async update(id: string, patch: Parameters<KindsRepo['update']>[1]): Promise<IssueKindRow> {
    await this.get(id);
    if (patch.event_codes) {
      const unknown = patch.event_codes.filter((c) => !isKnownEventCode(c));
      if (unknown.length) throw AppError.validation([{ path: 'event_codes', message: `unknown event code(s): ${unknown.join(', ')}` }]);
      patch.event_codes = patch.event_codes.map((c) => c.trim().toUpperCase());
    }
    const row = await this.repo.update(id, patch);
    if (!row) throw AppError.notFound('Issue kind not found');
    return row;
  }

  async link(submissionId: string, kindId: string, source: KindLinkSource, confidence: number | null, by: string | null) {
    await this.get(kindId);
    await this.repo.link(submissionId, kindId, source, confidence, by);
    return this.repo.forSubmission(submissionId);
  }

  async unlink(submissionId: string, kindId: string) {
    const removed = await this.repo.unlink(submissionId, kindId);
    if (!removed) throw AppError.notFound('That submission is not linked to this issue kind');
    return this.repo.forSubmission(submissionId);
  }

  forSubmission(submissionId: string) {
    return this.repo.forSubmission(submissionId);
  }

  /**
   * Attaches the model's suggested kind to a submission.
   *
   * Matches the suggested title against existing kinds ignoring case and punctuation, so
   * "Sleep start recorded late" and "sleep start recorded late." land on the same kind
   * instead of growing a new one per run. A miss creates the kind, credited to the model.
   */
  async applySuggestion(
    submissionId: string,
    suggestion: { title: string; rationale: string },
    context: { feature_key: string | null; tags: string[]; event_codes: string[]; severity: string | null },
  ): Promise<IssueKindRow | null> {
    const title = suggestion.title.trim();
    if (title.length < 4) return null;

    const wanted = normalizeTitle(title);
    const existing = (await this.repo.titles()).find((k) => normalizeTitle(k.title) === wanted);

    let kind: IssueKindRow;
    if (existing) {
      kind = (await this.repo.byId(existing.id))!;
    } else {
      // A generated key can still collide (two titles differing only in punctuation we strip
      // differently); suffix until it lands rather than failing the whole diagnosis.
      let key = slugify(title);
      for (let n = 2; await this.repo.byKey(key); n += 1) key = `${slugify(title).slice(0, 56)}_${n}`;
      kind = await this.repo.create({
        key,
        title,
        description: suggestion.rationale.trim() || null,
        feature_key: context.feature_key,
        tags: context.tags.slice(0, 6),
        event_codes: context.event_codes.slice(0, 6),
        severity: context.severity,
        created_by: 'ai',
      });
    }

    await this.repo.link(submissionId, kind.id, 'ai', null, 'ai');
    return kind;
  }
}
