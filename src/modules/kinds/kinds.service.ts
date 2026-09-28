import { AppError } from '../../lib/errors.js';
import { isKnownEventCode } from '../diagnosis/knowledge/catalog.js';
import { z } from 'zod';
import {
  KindsRepo, normalizeTitle, parseKindRef, slugify,
  type IssueKindRow, type KindCounts, type KindLink, type KindLinkSource, type KindStatus,
} from './kinds.repo.js';
import { oldestVersions, regressionVerdict, summarizeSkew } from './pinpoint.js';

/** A link on a report, with how big that problem is overall. */
export interface KindLinkWithCounts extends KindLink { counts: KindCounts | null }

type KindEvent = 'kind_link' | 'kind_suggest' | 'kind_confirm' | 'kind_reject' | 'regression';
/** Where grouping decisions go in a report's history. */
export interface KindActivity { record(e: { submissionId: string; actor: string | null; action: KindEvent; to: string; note?: string | null; touch: boolean }): Promise<unknown> }
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
  private activity: KindActivity | null = null;
  constructor(private readonly repo: KindsRepo) {}

  setActivity(a: KindActivity | null) { this.activity = a; }

  /** People's grouping decisions count as the team responding; the AI's and the matcher's do not. */
  private async log(submissionId: string, kind: { ref: string }, action: KindEvent, by: string | null, touch: boolean) {
    await this.activity?.record({ submissionId, actor: by, action, to: kind.ref, touch });
  }

  list(filters: Partial<CommonFilters> & { from?: string; to?: string; includeArchived?: boolean; status?: string }) {
    return this.repo.list(filters);
  }

  /** By uuid or by reference (LNK-0007). */
  async get(idOrRef: string) {
    let kind: IssueKindRow | undefined;
    if (z.string().uuid().safeParse(idOrRef).success) kind = await this.repo.byId(idOrRef);
    else {
      const refNo = parseKindRef(idOrRef);
      if (refNo !== null) kind = await this.repo.byRefNo(refNo);
    }
    if (!kind) throw AppError.notFound('Issue kind not found');
    return kind;
  }

  async detail(idOrRef: string, filters: Partial<CommonFilters> & { from?: string; to?: string }) {
    const kind = await this.get(idOrRef);
    const id = kind.id;
    const [withCounts, trend, referenceRef, mergedInto, skewRows, seen, regressions] = await Promise.all([
      this.repo.list({ ...filters, includeArchived: true }),
      this.repo.trend(id, filters),
      kind.reference_submission_id ? this.repo.submissionRef(kind.reference_submission_id) : Promise.resolve(null),
      kind.merged_into ? this.repo.byId(kind.merged_into) : Promise.resolve(undefined),
      this.repo.skew(id, filters),
      this.repo.versionsSeen(id, filters.is_test ?? null),
      this.repo.regressions(id),
    ]);
    const counts = withCounts.find((k) => k.id === id);
    return {
      ...kind,
      count: counts?.count ?? 0,
      users: counts?.users ?? 0,
      open_count: counts?.open_count ?? 0,
      ai_count: counts?.ai_count ?? 0,
      cx_count: counts?.cx_count ?? 0,
      cx_users: counts?.cx_users ?? 0,
      reference_ref: referenceRef,
      merged_into_ref: mergedInto?.ref ?? null,
      first_seen: counts?.first_seen ?? null,
      last_seen: counts?.last_seen ?? null,
      trend,
      /** Where it happens: this problem's firmware, app, OS and platform mix against all problem reports in the same slice. */
      skew: summarizeSkew(skewRows),
      /** The oldest versions it has been reported on, all time: usually where it came in. */
      oldest_versions: oldestVersions(seen),
      /** Reports on the fix version or later. */
      regressions,
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

  async update(idOrRef: string, patch: Parameters<KindsRepo['update']>[1]): Promise<IssueKindRow> {
    const { id } = await this.get(idOrRef);
    if (patch.event_codes) {
      const unknown = patch.event_codes.filter((c) => !isKnownEventCode(c));
      if (unknown.length) throw AppError.validation([{ path: 'event_codes', message: `unknown event code(s): ${unknown.join(', ')}` }]);
      patch.event_codes = patch.event_codes.map((c) => c.trim().toUpperCase());
    }
    const row = await this.repo.update(id, patch);
    if (!row) throw AppError.notFound('Issue kind not found');
    return row;
  }

  /** A person (or a diagnosis) says this report is an instance of that problem. */
  async link(submissionId: string, kindIdOrRef: string, source: KindLinkSource, confidence: number | null, by: string | null) {
    const kind = await this.get(kindIdOrRef);
    await this.repo.link(submissionId, kind.id, source, confidence, by, 'linked');
    await this.log(submissionId, kind, 'kind_link', by, source === 'manual');
    if (source === 'manual') await this.repo.clearRuleSuggestions(submissionId, kind.id);
    if (!kind.reference_submission_id && source === 'manual') await this.repo.update(kind.id, { reference_submission_id: submissionId });
    await this.checkRegression(submissionId, kind.id);
    return this.repo.forSubmission(submissionId);
  }

  /**
   * A report newly counted under a problem that has a fix version: if it ran that version or later,
   * the fix did not hold. The link is flagged, a fixed problem reopens as watching, and the report's
   * history says why. Test data and positive feedback never count, and a report whose version is
   * missing or unreadable is never flagged.
   */
  async checkRegression(submissionId: string, kindId: string): Promise<boolean> {
    const kind = await this.repo.byId(kindId);
    if (!kind || kind.status === 'wont_fix' || kind.merged_into) return false;
    if (!kind.fixed_in_app_version && !kind.fixed_in_firmware_version) return false;
    const link = (await this.repo.forSubmission(submissionId)).find((l) => l.kind_id === kindId);
    if (!link || link.state !== 'linked' || link.regression) return false;
    const ran = await this.repo.reportVersions(submissionId);
    if (!ran || ran.is_test || ran.is_positive) return false;
    const verdict = regressionVerdict(kind, ran);
    if (!verdict) return false;
    const reopen = kind.status === 'fixed';
    await this.repo.markRegression(submissionId, kind.id, reopen);
    await this.activity?.record({
      submissionId, actor: 'rule', action: 'regression', to: kind.ref, touch: false,
      note: `${verdict.reason}: ${kind.ref} came back.${reopen ? ' The problem was reopened as watching.' : ''}`,
    });
    return true;
  }

  /** CX (or anyone) thinks this report belongs to that problem; someone who can manage problems confirms it. */
  async suggest(submissionId: string, kindIdOrRef: string, by: string | null) {
    const kind = await this.get(kindIdOrRef);
    await this.repo.link(submissionId, kind.id, 'manual', null, by, 'suggested');
    await this.log(submissionId, kind, 'kind_suggest', by, false);
    return this.repo.forSubmission(submissionId);
  }

  /** A rule matched a new report to this problem: shown as a suggestion until a person decides. */
  async suggestByRule(submissionId: string, kindId: string, confidence: number) {
    await this.repo.link(submissionId, kindId, 'rule', Math.min(1, Math.max(0, confidence)), 'rule', 'suggested');
    const kind = await this.repo.byId(kindId);
    if (kind) await this.log(submissionId, kind, 'kind_suggest', 'rule', false);
  }

  /** Confirm a suggestion, or reject it (or an existing link) so it is never suggested again. */
  async decide(submissionId: string, kindIdOrRef: string, decision: 'confirm' | 'reject', by: string | null) {
    const kind = await this.get(kindIdOrRef);
    if (decision === 'confirm') {
      await this.repo.link(submissionId, kind.id, 'manual', null, by, 'linked');
      await this.repo.clearRuleSuggestions(submissionId, kind.id);
      await this.log(submissionId, kind, 'kind_confirm', by, true);
      await this.checkRegression(submissionId, kind.id);
      return this.repo.forSubmission(submissionId);
    }
    if (!(await this.repo.reject(submissionId, kind.id, by))) throw AppError.notFound('That submission is not linked to this issue kind');
    await this.log(submissionId, kind, 'kind_reject', by, true);
    return this.repo.forSubmission(submissionId);
  }

  /** Unlinking is a rejection: the link is remembered as "not this", so no rule or diagnosis puts it back. */
  async unlink(submissionId: string, kindIdOrRef: string, by: string | null = null) {
    return this.decide(submissionId, kindIdOrRef, 'reject', by);
  }

  forSubmission(submissionId: string) {
    return this.repo.forSubmission(submissionId);
  }

  /** The report's links, each with the problem's all-time size among reports like this one (real or test). */
  async forSubmissionWithCounts(submissionId: string, isTest: boolean): Promise<KindLinkWithCounts[]> {
    const links = await this.repo.forSubmission(submissionId);
    const counts = await this.repo.countsFor(links.map((l) => l.kind_id), isTest);
    return links.map((l) => ({ ...l, counts: counts.get(l.kind_id) ?? null }));
  }

  countsFor(kindIds: string[], isTest: boolean) {
    return this.repo.countsFor(kindIds, isTest);
  }

  /** Fold `from` into `into`: reports, tags, Jira and title move over; `from` is archived. */
  async merge(fromIdOrRef: string, intoIdOrRef: string): Promise<IssueKindRow> {
    const [from, into] = await Promise.all([this.get(fromIdOrRef), this.get(intoIdOrRef)]);
    if (from.id === into.id) throw AppError.validation([{ path: 'into', message: 'cannot merge a problem into itself' }]);
    if (into.merged_into) throw AppError.validation([{ path: 'into', message: `${into.ref} was itself merged away; merge into the problem it went to` }]);
    if (from.merged_into) throw AppError.validation([{ path: 'id', message: `${from.ref} was already merged` }]);
    if (from.jira_key && into.jira_key) {
      throw AppError.validation([{ path: 'into', message: `both problems have a Jira ticket (${from.jira_key}, ${into.jira_key}); close one in Jira and unlink it first` }], 'Cannot merge');
    }
    await this.repo.merge(from.id, into.id);
    return (await this.repo.byId(into.id))!;
  }

  /**
   * Links many reports to one problem at once ("these are all the same issue"). Creates the
   * problem from `title` when no kind is given, with the first report as its reference.
   */
  async linkMany(submissionIds: string[], target: { kind_id?: string; title?: string; feature_key?: string | null }, by: string | null) {
    const kind = target.kind_id
      ? await this.get(target.kind_id)
      : await this.create({ title: target.title ?? '', feature_key: target.feature_key ?? null }, by);
    for (const id of submissionIds) {
      await this.repo.link(id, kind.id, 'manual', null, by, 'linked');
      await this.repo.clearRuleSuggestions(id, kind.id);
      await this.log(id, kind, 'kind_link', by, true);
      await this.checkRegression(id, kind.id);
    }
    if (!kind.reference_submission_id && submissionIds[0]) await this.repo.update(kind.id, { reference_submission_id: submissionIds[0] });
    return (await this.repo.byId(kind.id))!;
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

    // Titles of problems merged into another count as that problem, so a merge sticks.
    const wanted = normalizeTitle(title);
    const existing = (await this.repo.titles()).find((k) => normalizeTitle(k.title) === wanted || k.aliases.some((a) => normalizeTitle(a) === wanted));

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

    // A diagnosis link counts straight away, but never overrides a person's "not this".
    await this.repo.link(submissionId, kind.id, 'ai', null, 'ai', 'linked');
    if ((await this.repo.forSubmission(submissionId)).some((l) => l.kind_id === kind.id && l.state === 'linked')) {
      await this.log(submissionId, kind, 'kind_link', 'ai', false);
      await this.checkRegression(submissionId, kind.id);
    }
    if (!kind.reference_submission_id) await this.repo.update(kind.id, { reference_submission_id: submissionId });
    return kind;
  }
}
