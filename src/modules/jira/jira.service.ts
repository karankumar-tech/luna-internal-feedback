import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { FEATURE_DEFINITIONS, type FeatureKey } from '../../schema/registry.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import type { DiagnosisRepo } from '../diagnosis/diagnosis.repo.js';
import type { FeedbackRepo, SubmissionRow } from '../feedback/feedback.repo.js';
import type { KindsRepo } from '../kinds/kinds.repo.js';
import { JIRA_REQUIRED_ENV, JiraClient, buildDescription, type JiraIssue } from './jira.client.js';

export interface JiraDeps {
  client: JiraClient | null;
  feedback: FeedbackRepo;
  diagnoses: DiagnosisRepo;
  kinds: KindsRepo;
  categories: CategoriesRepo;
  publicBaseUrl: string;
  log: FastifyBaseLogger;
}

/** Shown wherever a Jira action is attempted before the credentials exist. */
export const JIRA_PENDING_MESSAGE = 'Jira integration pending';

export interface JiraStatus {
  configured: boolean;
  project_key: string | null;
  issue_type: string | null;
  /** Env vars still to set, so the dashboard can name them instead of saying "not configured". */
  missing_env: string[];
  /** What to show on a disabled Jira control. */
  message: string | null;
}

export class JiraService {
  constructor(private readonly d: JiraDeps) {}

  get enabled(): boolean { return this.d.client !== null; }

  status(env: NodeJS.ProcessEnv = process.env): JiraStatus {
    const client = this.d.client;
    // A configured client is the source of truth; env is only consulted to say what is missing.
    return {
      configured: client !== null,
      project_key: client?.projectKey ?? null,
      issue_type: client?.issueType ?? null,
      missing_env: client ? [] : JIRA_REQUIRED_ENV.filter((k) => !env[k]),
      message: client ? null : JIRA_PENDING_MESSAGE,
    };
  }

  private client(): JiraClient {
    if (!this.d.client) {
      // Everything Jira-shaped is built and reachable; it simply has no credentials yet.
      // The message is deliberately the same everywhere so the dashboard can show it verbatim.
      const missing = this.status().missing_env;
      throw AppError.validation(
        missing.map((k) => ({ path: k, message: 'not set on the server' })),
        JIRA_PENDING_MESSAGE,
      );
    }
    return this.d.client;
  }

  /** Confirms the token and project before anyone tries to file a ticket with them. */
  async check() {
    return this.client().check();
  }

  /**
   * Creates the Jira issue for one submission and records the key.
   * Already linked? Returns the existing issue untouched — clicking twice must not open two tickets.
   */
  async createForSubmission(submissionId: string, by: string | null): Promise<{ issue: JiraIssue; created: boolean }> {
    const client = this.client();
    const sub = await this.d.feedback.byId(submissionId);
    if (!sub) throw AppError.notFound('Submission not found');

    if (sub.jira_key) {
      const issue = await client.getIssue(sub.jira_key);
      await this.d.feedback.setJiraStatus(sub.id, issue.status);
      return { issue, created: false };
    }

    const [diagnosis, kinds, categoryLabels, feature] = await Promise.all([
      this.d.diagnoses.get(sub.id),
      this.d.kinds.forSubmission(sub.id),
      this.d.categories.listAll(sub.feature_key).then((rows) => new Map(rows.map((c) => [c.key, c.label]))),
      this.d.categories.feature(sub.feature_key),
    ]);

    const featureLabel = feature?.label ?? sub.feature_key;
    const categories = sub.issue_categories.map((k) => categoryLabels.get(k) ?? k);
    const detailLabels = new Map((FEATURE_DEFINITIONS[sub.feature_key as FeatureKey]?.fields ?? []).map((f) => [f.key, f.label]));
    const details = Object.entries(sub.details)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => [detailLabels.get(k) ?? k, String(v)] as [string, string]);

    const summary = buildSummary(sub, featureLabel, categories, kinds.map((k) => k.title));
    const description = buildDescription({
      dashboardUrl: `${this.d.publicBaseUrl.replace(/\/+$/, '')}/dashboard/submissions/${sub.id}`,
      summaryLine: `Reported through Luna internal feedback on ${sub.occurred_on} (IST).`,
      reporter: { user_id: Number(sub.user_id), email: sub.email, environment: sub.environment, platform: sub.platform },
      occurredOn: sub.occurred_on,
      feature: featureLabel,
      categories,
      testerWords: sub.feedback_text,
      details,
      diagnosis: diagnosis
        ? {
            side: diagnosis.root_cause_side,
            confidence: diagnosis.confidence === null ? null : Number(diagnosis.confidence),
            severity: diagnosis.severity,
            tags: diagnosis.tags ?? [],
            event_codes: diagnosis.event_codes ?? [],
            summary: diagnosis.summary,
            suggested_fix: diagnosis.suggested_fix,
            evidence: (diagnosis.evidence as { source: string; ts: string | null; line: string }[] | null) ?? [],
          }
        : null,
      kinds: kinds.map((k) => k.title),
      screenshots: (sub.screenshots ?? []).map((s) => s.url),
    });

    const labels = [
      `luna-${sub.feature_key}`,
      `env-${sub.environment}`,
      ...(sub.platform ? [`platform-${sub.platform}`] : []),
      ...(diagnosis?.root_cause_side ? [`side-${diagnosis.root_cause_side}`] : []),
    ];

    const issue = await client.createIssue({ summary, description, labels });
    await this.d.feedback.setJira(sub.id, { key: issue.key, url: issue.url, status: issue.status, by });
    this.d.log.info({ submissionId: sub.id, jira: issue.key }, 'jira issue created');
    return { issue, created: true };
  }

  /** Pulls the current workflow status for one submission's ticket. */
  async refreshSubmission(submissionId: string): Promise<JiraIssue> {
    const client = this.client();
    const sub = await this.d.feedback.byId(submissionId);
    if (!sub) throw AppError.notFound('Submission not found');
    if (!sub.jira_key) throw AppError.validation([{ path: 'jira_key', message: 'this submission has no Jira ticket yet' }]);
    const issue = await client.getIssue(sub.jira_key);
    await this.d.feedback.setJiraStatus(sub.id, issue.status);
    return issue;
  }

  /** One ticket for a whole recurring problem, rather than one per report. */
  async createForKind(kindId: string, by: string | null): Promise<{ issue: JiraIssue; created: boolean }> {
    const client = this.client();
    const kind = await this.d.kinds.byId(kindId);
    if (!kind) throw AppError.notFound('Issue kind not found');

    if (kind.jira_key) {
      const issue = await client.getIssue(kind.jira_key);
      return { issue, created: false };
    }

    const [counts] = await this.d.kinds.list({ includeArchived: true, is_test: false }).then((rows) => [rows.find((k) => k.id === kindId)]);
    const dashboardUrl = `${this.d.publicBaseUrl.replace(/\/+$/, '')}/dashboard/kinds/${kind.id}`;
    const description = buildDescription({
      dashboardUrl,
      summaryLine: kind.description ?? `Recurring issue tracked in Luna internal feedback: ${kind.title}.`,
      reporter: { user_id: 0, email: by ?? 'luna-feedback', environment: 'stage', platform: null },
      occurredOn: counts?.first_seen ?? new Date().toISOString().slice(0, 10),
      feature: kind.feature_key ?? 'multiple',
      categories: [],
      testerWords: null,
      details: [
        ['Reports so far', String(counts?.count ?? 0)],
        ['Distinct testers', String(counts?.users ?? 0)],
        ['First seen', counts?.first_seen ?? 'unknown'],
        ['Last seen', counts?.last_seen ?? 'unknown'],
        ...(kind.tags.length ? ([['Tags', kind.tags.join(', ')]] as [string, string][]) : []),
        ...(kind.event_codes.length ? ([['Catalog events', kind.event_codes.join(', ')]] as [string, string][]) : []),
      ],
      diagnosis: null,
      kinds: [],
      screenshots: [],
    });

    const issue = await client.createIssue({
      summary: kind.title.slice(0, 250),
      description,
      labels: ['luna-issue-kind', ...(kind.feature_key ? [`luna-${kind.feature_key}`] : []), ...kind.tags],
    });
    await this.d.kinds.update(kind.id, { jira_key: issue.key, jira_url: issue.url });
    return { issue, created: true };
  }

  /**
   * Refreshes cached Jira statuses in the background (nightly cron).
   * Failures on one ticket never stop the rest: a deleted or moved issue is common enough.
   */
  async refreshStale(limit = 25, olderThanMinutes = 60): Promise<{ checked: number; updated: number }> {
    if (!this.d.client) return { checked: 0, updated: 0 };
    const rows = await this.d.feedback.jiraStale(limit, olderThanMinutes);
    let updated = 0;
    for (const row of rows) {
      try {
        const issue = await this.d.client.getIssue(row.jira_key);
        await this.d.feedback.setJiraStatus(row.id, issue.status);
        updated += 1;
      } catch (err) {
        this.d.log.warn({ err, jira: row.jira_key }, 'could not refresh jira status');
        await this.d.feedback.setJiraStatus(row.id, null);
      }
    }
    return { checked: rows.length, updated };
  }
}

/** A Jira summary someone can scan on a board: what broke, where, for whom. */
function buildSummary(sub: SubmissionRow, featureLabel: string, categories: string[], kinds: string[]): string {
  const lead = kinds[0] ?? categories[0] ?? sub.feedback_text?.trim().split(/\s+/).slice(0, 10).join(' ') ?? 'Issue reported';
  const env = sub.environment === 'production' ? '' : ` [${sub.environment}]`;
  return `[Luna${env}] ${featureLabel}: ${lead}`.slice(0, 250);
}
