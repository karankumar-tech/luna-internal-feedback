import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { formatInZone, todayInZone } from '../../lib/time.js';
import { buildBetaSubmissionValidator, buildCxSubmissionValidator, buildSubmissionValidator, zodIssues, type ValidatorContext } from '../../schema/buildValidator.js';
import { DEFAULT_BETA_ENVIRONMENT, DEFAULT_CX_ENVIRONMENT, SCHEMA_VERSION, isFeatureKey, type FeatureKey, type Platform } from '../../schema/registry.js';
import { redact } from '../diagnosis/logs/redact.js';
import { maskEmail } from '../../lib/mask-email.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import { MAX_TAGS, TERMINAL_STATUSES, VERSION_FIELDS, normalizeTag, parseSubmissionRef, type FeedbackRepo, type ReportVersions, type NewSubmission, type Priority, type SubmissionRow, type ListFilters, type StatsFilters, type Screenshot, type SubmissionStatus } from './feedback.repo.js';
import type { ActivityRepo, NoteVisibility } from '../activity/activity.repo.js';
import { ASSIGN_BACK_DEFAULTS, ASSIGN_BACK_STATUSES, assignBackTo, type ActiveAccount } from './assign-back.js';
import type { FastifyBaseLogger } from 'fastify';

/** Minimal hook so the feedback module does not depend on the diagnosis module directly. */
export interface DiagnosisHook { onNegativeSubmission(submissionId: string, log: FastifyBaseLogger): Promise<void> }

/** Fills a CX report's user id and device details from the logging service, after the response. */
export interface DeviceHook { onCxSubmission(submissionId: string, log: FastifyBaseLogger): Promise<void> }

/**
 * Proposes the open problem a new issue most likely belongs to. `wait` runs it before the
 * response, for callers that show the answer straight away (the CX tool).
 */
export interface SimilarityHook { onNewIssue(submissionId: string, log: FastifyBaseLogger, wait: boolean): Promise<void> }

/** Sprints, kept behind a hook so the feedback module does not depend on the sprints module. */
export interface SprintHook {
  /** "current", "next" (created when none is planned) or a reference like SPR-202610-01. */
  resolve(target: string, by: string | null): Promise<{ id: string; ref: string; status: 'planned' | 'active' | 'closed' }>;
}

const TERMINAL: readonly string[] = TERMINAL_STATUSES;

export interface SubmissionDto extends Omit<SubmissionRow, 'created_at' | 'user_id' | 'idempotency_key' | 'ai_checked_at' | 'status_changed_at' | 'jira_synced_at' | 'first_touched_at' | 'last_activity_at' | 'resolved_at'> {
  user_id: number | null;
  first_touched_at: string | null;
  last_activity_at: string | null;
  resolved_at: string | null;
  created_at: string;      // ISO 8601 UTC
  created_at_ist: string;  // "YYYY-MM-DD HH:mm:ss +05:30"
  ai_checked_at: string | null;
  status_changed_at: string | null;
  jira_synced_at: string | null;
}

/** The fields of a screenshot that are stored, with the ones not sent as null. */
const shotOf = (x: Screenshot): Screenshot => ({
  file_id: x.file_id, url: x.url, thumbnail_url: x.thumbnail_url ?? null, name: x.name ?? null, width: x.width ?? null, height: x.height ?? null, size: x.size ?? null,
  upload_size: x.upload_size ?? null, original_width: x.original_width ?? null, original_height: x.original_height ?? null,
});

export class FeedbackService {
  private diagnosis: DiagnosisHook | null = null;
  private device: DeviceHook | null = null;
  private similarity: SimilarityHook | null = null;
  private sprints: SprintHook | null = null;
  private activity: ActivityRepo | null = null;
  /** Active dashboard accounts by email or id, for handing a fixed report back (wired in build-app). */
  private accounts: ((emails: string[], ids: readonly string[]) => Promise<ActiveAccount[]>) | null = null;
  /** Whether a Luna user id is on the beta list (wired in build-app). Without it, beta reports are refused. */
  private isBetaUser: ((userId: number) => Promise<boolean>) | null = null;
  /** Screenshot URL validator + cleanup, wired when ImageKit is configured. */
  private screenshots: { isOurUrl: (u: string) => boolean; maxCount: number; deleteFile: (id: string) => Promise<boolean> } | null = null;

  constructor(
    private readonly feedback: FeedbackRepo,
    private readonly categories: CategoriesRepo,
    private readonly timeZone: string,
  ) {}

  setDiagnosisHook(hook: DiagnosisHook | null) { this.diagnosis = hook; }
  setDeviceHook(hook: DeviceHook | null) { this.device = hook; }
  setSimilarityHook(hook: SimilarityHook | null) { this.similarity = hook; }
  setSprintHook(hook: SprintHook | null) { this.sprints = hook; }
  setActivity(repo: ActivityRepo | null) { this.activity = repo; }
  setAccountLookup(fn: ((emails: string[], ids: readonly string[]) => Promise<ActiveAccount[]>) | null) { this.accounts = fn; }
  setBetaCheck(fn: ((userId: number) => Promise<boolean>) | null) { this.isBetaUser = fn; }
  setScreenshotSupport(s: { isOurUrl: (u: string) => boolean; maxCount: number; deleteFile: (id: string) => Promise<boolean> } | null) { this.screenshots = s; }

  toDto(row: SubmissionRow): SubmissionDto {
    const { idempotency_key: _omit, ...rest } = row;
    return {
      ...rest,
      user_id: row.user_id === null ? null : Number(row.user_id),
      ai_checked_at: row.ai_checked_at ? new Date(row.ai_checked_at).toISOString() : null,
      status_changed_at: row.status_changed_at ? new Date(row.status_changed_at).toISOString() : null,
      jira_synced_at: row.jira_synced_at ? new Date(row.jira_synced_at).toISOString() : null,
      first_touched_at: row.first_touched_at ? new Date(row.first_touched_at).toISOString() : null,
      last_activity_at: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
      resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      created_at: row.created_at.toISOString(),
      created_at_ist: formatInZone(row.created_at, this.timeZone),
    };
  }

  /**
   * A report from an internal tester: through the Luna app, or filed by a signed-in person from the
   * dashboard's Report page (`source.via = 'dashboard'`, with `by` naming them in the history and
   * `owner` the account it is assigned to, already checked by the route).
   */
  async submit(featureKey: string, body: unknown, idempotencyKey: string | null, log?: FastifyBaseLogger, source: { via: 'app' | 'dashboard'; by: string | null; owner?: string | null } = { via: 'app', by: null }) {
    const { feature, ctx } = await this.prepare(featureKey);
    const parsed = buildSubmissionValidator(feature, ctx).safeParse(body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const v = parsed.data;
    const choice = v.sprint as 'current' | 'next' | null | undefined;
    if (choice && !this.sprints) throw AppError.validation([{ path: 'sprint', message: 'sprints are not available' }]);
    const sprint = choice ? await this.sprints!.resolve(choice, source.by) : null;

    return this.store({
      ...this.commonFields(feature, v),
      user_id: v.user_id as number,
      email: v.email as string,
      email_masked: null,
      feedback_text: (v.feedback_text as string | null | undefined) ?? null,
      device_serial: (v.device_serial as string | null | undefined) || null,
      client: this.clientFields(v.client),
      idempotency_key: idempotencyKey,
      origin: 'internal',
      submitted_via: source.via,
      cx: null,
      sprint_id: sprint?.id ?? null,
      assigned_to: source.owner ?? null,
    }, log, false, source.by);
  }

  /**
   * A customer problem filed by CX from its own tool. The ring serial and the CX ticket identify
   * it; the customer's email, if sent, is kept only masked, and any address or phone number in the
   * free text is redacted before it is stored.
   */
  async submitCx(featureKey: string, body: unknown, via: 'cx_tool' | 'admin', log?: FastifyBaseLogger) {
    const { feature, ctx } = await this.prepare(featureKey);
    const parsed = buildCxSubmissionValidator(feature, ctx).safeParse(body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const v = parsed.data as Record<string, unknown> & {
      device_serial: string;
      cx: { ref: string; url?: string | null; channel?: string | null; agent?: string | null; transcript?: string | null };
    };
    const scrub = (t: string | null | undefined) => (t ? redact(t) : null);

    const client = this.clientFields(v.client);
    const result = await this.store({
      ...this.commonFields(feature, v),
      user_id: (v.user_id as number | null | undefined) ?? null,
      email: null,
      email_masked: maskEmail(v.email as string | null | undefined),
      feedback_text: scrub(v.feedback_text as string | null | undefined),
      device_serial: v.device_serial,
      client: { ...client, environment: client.environment ?? DEFAULT_CX_ENVIRONMENT },
      // The CX ticket is the idempotency key: the same ticket and feature always return the first report.
      idempotency_key: null,
      origin: 'cx',
      submitted_via: via,
      sprint_id: null,
      cx: {
        ref: v.cx.ref,
        url: v.cx.url ?? null,
        channel: v.cx.channel ?? null,
        agent: v.cx.agent || null,
        transcript: scrub(v.cx.transcript),
      },
    }, log, true);
    if (result.created && this.device && log) {
      try { await this.device.onCxSubmission(result.dto.id, log); } catch (err) { log.error({ err }, 'could not queue the device lookup'); }
    }
    return result;
  }

  /**
   * A report from a beta user: a production customer on the beta list, sending from the released
   * app. The app's usual body is accepted, but the email is kept only masked and the free text
   * redacted, as for any customer; the user id must be on the list.
   */
  async submitBeta(featureKey: string, body: unknown, idempotencyKey: string | null, log?: FastifyBaseLogger) {
    const { feature, ctx } = await this.prepare(featureKey);
    const parsed = buildBetaSubmissionValidator(feature, ctx).safeParse(body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    const v = parsed.data;
    const userId = v.user_id as number;
    if (!this.isBetaUser || !(await this.isBetaUser(userId))) {
      throw new AppError(403, 'NOT_A_BETA_USER', `User ${userId} is not a beta user`);
    }

    const client = this.clientFields(v.client);
    return this.store({
      ...this.commonFields(feature, v),
      user_id: userId,
      email: null,
      email_masked: maskEmail(v.email as string | null | undefined),
      feedback_text: v.feedback_text ? redact(v.feedback_text as string) : null,
      device_serial: (v.device_serial as string | null | undefined) || null,
      client: { ...client, environment: client.environment ?? DEFAULT_BETA_ENVIRONMENT },
      idempotency_key: idempotencyKey,
      origin: 'beta',
      submitted_via: 'app',
      cx: null,
      sprint_id: null,
    }, log, false);
  }

  private async prepare(featureKey: string): Promise<{ feature: FeatureKey; ctx: ValidatorContext }> {
    if (!isFeatureKey(featureKey)) throw AppError.notFound(`Unknown feature "${featureKey}"`);
    const feature = await this.categories.feature(featureKey);
    if (!feature || !feature.is_active) throw AppError.notFound(`Feature "${featureKey}" is not accepting feedback`);
    const categoryKeys = await this.categories.activeKeysFor(featureKey);
    return {
      feature: featureKey,
      ctx: {
        categoryKeys, timeZone: this.timeZone,
        isScreenshotUrl: this.screenshots ? this.screenshots.isOurUrl : undefined,
        maxScreenshots: this.screenshots?.maxCount,
      },
    };
  }

  /** Fields read the same way whichever caller sent the report. */
  private commonFields(feature: FeatureKey, v: Record<string, unknown>) {
    const details: Record<string, unknown> = {};
    for (const [k, val] of Object.entries((v.details as Record<string, unknown> | undefined) ?? {})) if (val !== undefined && val !== null) details[k] = val;
    return {
      feature_key: feature,
      is_positive: v.is_positive as boolean,
      occurred_on: (v.occurred_on as string | null | undefined) ?? todayInZone(this.timeZone),
      issue_categories: (v.issue_categories as string[] | null | undefined) ?? [],
      screenshots: ((v.screenshots as Screenshot[] | null | undefined) ?? []).map(shotOf),
      details,
      schema_version: SCHEMA_VERSION,
      is_test: v.is_test === true,
    };
  }

  private clientFields(raw: unknown): NewSubmission['client'] {
    const client: Record<string, string | null> = {};
    for (const [k, val] of Object.entries((raw as Record<string, unknown> | null | undefined) ?? {})) if (typeof val === 'string' && val.length > 0) client[k] = val;
    return client;
  }

  /** `by`: the person who filed it, when one did; otherwise the history names the credential. */
  private async store(input: NewSubmission, log: FastifyBaseLogger | undefined, waitForSuggestion: boolean, by: string | null = null) {
    const { row, created } = await this.feedback.insert(input);
    if (created && this.activity) await this.activity.record({ submissionId: row.id, actor: by ?? input.submitted_via, action: 'created', to: row.origin, touch: false });
    if (created && this.activity && row.sprint) await this.activity.record({ submissionId: row.id, actor: by ?? input.submitted_via, action: 'sprint', to: row.sprint.ref, note: 'Filed into the sprint', touch: false });
    // Part of filing it, not a response to it: the attention clock is left alone.
    if (created && this.activity && row.assigned_to) await this.activity.record({ submissionId: row.id, actor: by ?? input.submitted_via, action: 'assign', to: row.assigned_to, note: 'when filing it', touch: false });
    if (created && !row.is_positive && this.diagnosis && log) {
      // Queue + start after the response; never let diagnosis problems break the submit.
      try { await this.diagnosis.onNegativeSubmission(row.id, log); } catch (err) { log.error({ err }, 'could not queue diagnosis'); }
    }
    if (created && !row.is_positive && this.similarity && log) {
      // A suggestion is a convenience: it never fails the submit.
      try { await this.similarity.onNewIssue(row.id, log, waitForSuggestion); } catch (err) { log.error({ err }, 'could not suggest a problem'); }
    }
    return { dto: this.toDto(row), created };
  }

  /** By uuid or by reference: "LN-00042", "ln-42" and "42" all find the same report. */
  async get(idOrRef: string): Promise<SubmissionDto> {
    return this.toDto(await this.row(idOrRef));
  }

  async row(idOrRef: string): Promise<SubmissionRow> {
    let row: SubmissionRow | undefined;
    if (z.string().uuid().safeParse(idOrRef).success) row = await this.feedback.byId(idOrRef);
    else {
      const refNo = parseSubmissionRef(idOrRef);
      if (refNo !== null) row = await this.feedback.byRefNo(refNo);
    }
    if (!row) throw AppError.notFound('Submission not found');
    return row;
  }

  async list(filters: ListFilters) {
    const { rows, nextCursor } = await this.feedback.list(filters);
    return { items: rows.map((r) => this.toDto(r)), next_cursor: nextCursor };
  }

  async stats(filters: StatsFilters) {
    return this.feedback.stats(filters);
  }

  async setTestFlag(id: string, isTest: boolean, by: string | null = null): Promise<SubmissionDto> {
    const before = await this.row(id);
    const row = await this.feedback.setTestFlag(before.id, isTest);
    if (!row) throw AppError.notFound('Submission not found');
    if (before.is_test !== isTest) await this.activity?.record({ submissionId: row.id, actor: by, action: 'test_flag', from: String(before.is_test), to: String(isTest), touch: false });
    return this.toDto(row);
  }

  /** `touch`: a team member did it, so it counts as a response and resets "stale". */
  /**
   * `assignBack`: a report newly marked Fixed or Won't fix goes back to whoever filed it (see
   * assign-back.ts). Callers pass false when the same change names an owner itself.
   */
  async setStatus(id: string, status: SubmissionStatus, note: string | null, by: string | null, touch = true, assignBack = true): Promise<SubmissionDto> {
    const before = await this.row(id);
    let row = await this.feedback.setStatus(before.id, status, note, by);
    if (!row) throw AppError.notFound('Submission not found');
    if (before.status !== status || note) await this.activity?.record({ submissionId: row.id, actor: by, action: 'status', from: before.status, to: status, note, touch });
    if (assignBack && before.status !== status && ASSIGN_BACK_STATUSES.includes(status)) row = await this.handBack(row, status, by);
    // A closed sprint only holds finished issues: one reopened there goes to the current sprint.
    if (TERMINAL.includes(before.status) && !TERMINAL.includes(status) && row.sprint?.status === 'closed' && this.sprints) {
      const current = await this.sprints.resolve('current', by).catch(() => null);
      if (current) {
        row = (await this.feedback.setSprint(row.id, current.id)) ?? row;
        await this.activity?.record({ submissionId: row.id, actor: by, action: 'sprint', from: before.sprint?.ref ?? null, to: current.ref, note: 'Reopened, so moved to the current sprint', touch: false });
      }
    }
    return this.toDto(row);
  }

  /** Assigns a report just marked Fixed or Won't fix to its reporter, or to QC's default owner. */
  private async handBack(row: SubmissionRow, status: SubmissionStatus, by: string | null): Promise<SubmissionRow> {
    if (!this.accounts) return row;
    const filer = row.submitted_via === 'dashboard' ? await this.activity?.filedBy(row.id) ?? null : null;
    const reporters = [filer, row.email].filter((x): x is string => !!x && x.includes('@'));
    const to = assignBackTo(reporters, await this.accounts(reporters, ASSIGN_BACK_DEFAULTS.map((d) => d.id)));
    if (!to || to.email === row.assigned_to) return row;
    const updated = await this.feedback.setAssignee(row.id, to.email);
    if (!updated) return row;
    const marked = `marked ${status === 'fixed' ? 'Fixed' : "Won't fix"}`;
    await this.activity?.record({
      submissionId: row.id, actor: by, action: 'assign', from: row.assigned_to, to: to.email, touch: false,
      note: to.reason === 'reporter' ? `back to the reporter, ${marked}` : `${marked}; the reporter has no dashboard account`,
    });
    return updated;
  }

  /**
   * Moves a report into a sprint ("current", "next" or a reference), or with null back to the main
   * list. Only issues go into sprints, and never into a closed one. Bookkeeping, not a response:
   * it does not reset the attention clock.
   */
  async moveToSprint(id: string, target: string | null, by: string | null): Promise<SubmissionDto> {
    const before = await this.row(id);
    if (target !== null && before.is_positive) throw AppError.validation([{ path: 'sprint', message: 'only issues can be in a sprint, not "working fine" feedback' }]);
    if (target !== null && !this.sprints) throw AppError.validation([{ path: 'sprint', message: 'sprints are not available' }]);
    const dest = target === null ? null : await this.sprints!.resolve(target, by);
    if (dest?.status === 'closed') throw AppError.conflict(`${dest.ref} is closed: move it to the current or a planned sprint`);
    if ((before.sprint_id ?? null) === (dest?.id ?? null)) return this.toDto(before);
    const row = await this.feedback.setSprint(before.id, dest?.id ?? null);
    if (!row) throw AppError.notFound('Submission not found');
    await this.activity?.record({ submissionId: row.id, actor: by, action: 'sprint', from: before.sprint?.ref ?? null, to: dest?.ref ?? null, touch: false });
    return this.toDto(row);
  }

  /** Give a report an owner (any dashboard user), or none. */
  async assign(id: string, email: string | null, by: string | null): Promise<SubmissionDto> {
    const before = await this.row(id);
    const row = await this.feedback.setAssignee(before.id, email);
    if (!row) throw AppError.notFound('Submission not found');
    if (before.assigned_to !== email) await this.activity?.record({ submissionId: row.id, actor: by, action: 'assign', from: before.assigned_to, to: email, touch: true });
    return this.toDto(row);
  }

  async setPriority(id: string, priority: Priority | null, by: string | null): Promise<SubmissionDto> {
    const before = await this.row(id);
    const row = await this.feedback.setPriority(before.id, priority);
    if (!row) throw AppError.notFound('Submission not found');
    if (before.priority !== priority) await this.activity?.record({ submissionId: row.id, actor: by, action: 'priority', from: before.priority, to: priority, touch: true });
    return this.toDto(row);
  }

  /**
   * QC's call on where an issue lives: the app sends its phone's platform, and QC may change it,
   * for instance to backend or firmware. The history keeps what it was.
   */
  async setPlatform(id: string, platform: Platform | null, by: string | null): Promise<SubmissionDto> {
    const before = await this.row(id);
    if (before.platform === platform) return this.toDto(before);
    const row = await this.feedback.setPlatform(before.id, platform);
    if (!row) throw AppError.notFound('Submission not found');
    await this.activity?.record({ submissionId: row.id, actor: by, action: 'platform', from: before.platform, to: platform, touch: true });
    return this.toDto(row);
  }

  /**
   * QC's correction of the build a report came from. The app fills in app_version and firmware_version
   * on its own, and a report filed from the dashboard or by CX may carry neither; QC can set or fix
   * either from the report's page. "" clears, like null. The history keeps one entry per field changed.
   */
  async setVersions(id: string, versions: ReportVersions, by: string | null): Promise<SubmissionDto> {
    const before = await this.row(id);
    const change: ReportVersions = {};
    for (const key of VERSION_FIELDS) {
      const next = versions[key] === undefined ? undefined : versions[key] || null;
      if (next !== undefined && next !== before[key]) change[key] = next;
    }
    if (!Object.keys(change).length) return this.toDto(before);
    const row = await this.feedback.setVersions(before.id, change);
    if (!row) throw AppError.notFound('Submission not found');
    for (const key of VERSION_FIELDS) {
      if (change[key] !== undefined) await this.activity?.record({ submissionId: row.id, actor: by, action: key, from: before[key], to: change[key], touch: true });
    }
    return this.toDto(row);
  }

  /**
   * Adds and removes tags in one step. Tags are normalised (lowercase, spaces to dashes); a tag both
   * added and removed ends up removed. The history records the whole set before and after.
   */
  async changeTags(id: string, change: { add?: string[]; remove?: string[] }, by: string | null): Promise<SubmissionDto> {
    const bad = [...(change.add ?? []), ...(change.remove ?? [])].find((t) => normalizeTag(t) === null);
    if (bad !== undefined) throw AppError.validation([{ path: 'tags', message: `"${bad}" is not a tag: use letters, digits, dot, dash or underscore, up to 30` }]);
    const remove = new Set((change.remove ?? []).map((t) => normalizeTag(t)!));
    const before = await this.row(id);
    const next = [...new Set([...before.tags, ...(change.add ?? []).map((t) => normalizeTag(t)!)])].filter((t) => !remove.has(t));
    if (next.length > MAX_TAGS) throw AppError.validation([{ path: 'tags', message: `at most ${MAX_TAGS} tags on a report` }]);
    if (next.length === before.tags.length && next.every((t, i) => t === before.tags[i])) return this.toDto(before);
    const row = await this.feedback.setTags(before.id, next);
    if (!row) throw AppError.notFound('Submission not found');
    await this.activity?.record({ submissionId: row.id, actor: by, action: 'tag', from: before.tags.join(', ') || null, to: next.join(', ') || null, touch: true });
    return this.toDto(row);
  }

  /** Plans (or, with null, unplans) the date the fix goes live. The history keeps both dates. */
  async setGoLive(id: string, date: string | null, by: string | null): Promise<SubmissionDto> {
    const before = await this.row(id);
    if (before.go_live_on === date) return this.toDto(before);
    const row = await this.feedback.setGoLive(before.id, date);
    if (!row) throw AppError.notFound('Submission not found');
    await this.activity?.record({ submissionId: row.id, actor: by, action: 'go_live', from: before.go_live_on, to: date, touch: true });
    return this.toDto(row);
  }

  /** True for an image from our own ImageKit upload flow; false when uploads are not set up. */
  isScreenshotUrl(u: string): boolean { return this.screenshots ? this.screenshots.isOurUrl(u) : false; }

  /**
   * Screenshots added to a report already filed, uploaded first as the app's are, up to the limit a
   * new report has. Each one records who added it. Files the report already holds are skipped.
   */
  async addScreenshots(id: string, shots: Screenshot[], by: string | null): Promise<SubmissionDto> {
    if (!this.screenshots) throw AppError.validation([{ path: 'screenshots', message: 'screenshot uploads are not configured on the server' }], 'Uploads unavailable');
    const bad = shots.findIndex((s) => !this.screenshots!.isOurUrl(s.url));
    if (bad >= 0) throw AppError.validation([{ path: `screenshots.${bad}.url`, message: 'must be an ImageKit URL from the screenshot upload flow' }]);
    const before = await this.row(id);
    const held = new Set(before.screenshots.map((s) => s.file_id));
    const at = new Date().toISOString();
    const fresh = shots
      .filter((s, i) => !held.has(s.file_id) && shots.findIndex((x) => x.file_id === s.file_id) === i)
      .map((s) => ({ ...shotOf(s), added_by: by, added_at: at }));
    if (!fresh.length) return this.toDto(before);
    const max = this.screenshots.maxCount;
    const row = await this.feedback.addScreenshots(before.id, fresh, max);
    if (!row) {
      const room = Math.max(0, max - before.screenshots.length);
      throw AppError.conflict(room
        ? `${before.ref} has ${before.screenshots.length} screenshots and holds at most ${max}: ${room} more fit`
        : `${before.ref} already has ${max} screenshots. Remove one to add another.`);
    }
    await this.activity?.record({ submissionId: row.id, actor: by, action: 'screenshot', from: String(before.screenshots.length), to: String(row.screenshots.length), touch: true });
    return this.toDto(row);
  }

  /**
   * Takes off a screenshot added on the dashboard and deletes the image. What the reporter sent stays
   * as their evidence. The person who added it may remove it, and so may QC (`mayRemoveAny`).
   */
  async removeScreenshot(id: string, fileId: string, by: string | null, mayRemoveAny: boolean): Promise<SubmissionDto> {
    const before = await this.row(id);
    const shot = before.screenshots.find((s) => s.file_id === fileId);
    if (!shot) throw AppError.notFound('No such screenshot on this report');
    if (!shot.added_by) throw AppError.conflict('This screenshot came with the report; only screenshots added on the dashboard can be removed');
    if (!mayRemoveAny && shot.added_by !== by) throw AppError.forbidden(`Only ${shot.added_by} or QC can remove this screenshot`);
    const row = await this.feedback.removeScreenshot(before.id, fileId);
    if (!row) throw AppError.notFound('No such screenshot on this report');
    await this.activity?.record({ submissionId: row.id, actor: by, action: 'screenshot', from: String(before.screenshots.length), to: String(row.screenshots.length), touch: true });
    // Best effort: the report no longer points at it either way.
    if (this.screenshots) await this.screenshots.deleteFile(fileId).catch(() => false);
    return this.toDto(row);
  }

  /** Tags in use, most used first, with the common ones always included. */
  knownTags() { return this.feedback.knownTags(); }

  /**
   * A note on a report. On a CX report the text is redacted like everything else CX sends, since
   * notes can quote the customer. `touch` is false for notes from the CX tool: a customer's reply is
   * not the team responding.
   */
  async addNote(id: string, body: string, visibility: NoteVisibility, by: string | null, touch = true) {
    const sub = await this.row(id);
    if (!this.activity) throw AppError.validation([{ path: 'note', message: 'notes are not available' }]);
    const note = sub.origin === 'cx' ? redact(body) : body;
    return this.activity.record({ submissionId: sub.id, actor: by, action: 'note', note, visibility, touch });
  }

  /**
   * Asks the reporter questions and parks the report as needs_info. On a CX report the questions
   * are a customer-safe note, so the CX tool can relay them.
   */
  async askReporter(id: string, questions: string[], by: string | null): Promise<SubmissionDto> {
    const sub = await this.row(id);
    const text = questions.map((q) => `• ${q}`).join('\n');
    await this.activity?.record({
      submissionId: sub.id, actor: by, action: 'ask_reporter', note: `Questions for the ${sub.origin === 'cx' ? 'customer' : sub.origin === 'beta' ? 'beta user' : 'tester'}:\n${text}`,
      visibility: sub.origin === 'cx' ? 'customer' : 'internal', touch: true,
    });
    return this.setStatus(sub.id, 'needs_info', null, by);
  }

  /** The reporter answered: a report parked as needs_info goes back to where it was. */
  async reopenAfterReply(id: string, by: string | null): Promise<SubmissionDto | null> {
    const sub = await this.row(id);
    if (sub.status !== 'needs_info' || !this.activity) return null;
    const back = (await this.activity.statusBeforeNeedsInfo(sub.id)) ?? 'open';
    const status = (back === 'needs_info' ? 'open' : back) as SubmissionStatus;
    return this.setStatus(sub.id, status, 'Reporter replied', by, false);
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
