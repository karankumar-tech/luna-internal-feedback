import { AppError } from '../../lib/errors.js';

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  labels: string[];
}

export interface JiraIssue {
  key: string;
  url: string;
  status: string | null;
  summary: string | null;
  assignee: string | null;
  updated: string | null;
}

/** One paragraph of Atlassian Document Format. */
function paragraph(text: string) {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

function heading(text: string) {
  return { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] };
}

function bullets(items: string[]) {
  return {
    type: 'bulletList',
    content: items.map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
  };
}

function codeBlock(text: string) {
  return { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text }] };
}

export interface DescriptionInput {
  /** Link back to this ticket in the feedback dashboard. */
  dashboardUrl: string;
  summaryLine: string;
  reporter: { user_id: number; email: string; environment: string; platform: string | null };
  occurredOn: string;
  feature: string;
  categories: string[];
  testerWords: string | null;
  details: [string, string][];
  diagnosis: {
    side: string | null;
    confidence: number | null;
    severity: string | null;
    tags: string[];
    event_codes: string[];
    summary: string | null;
    suggested_fix: string | null;
    evidence: { source: string; ts: string | null; line: string }[];
  } | null;
  kinds: string[];
  screenshots: string[];
}

/**
 * Builds the issue description.
 *
 * Deliberately self-contained: whoever picks the ticket up in Jira should not have to open
 * the dashboard to know what happened, so the tester's words, the verdict and the log lines
 * it rests on are all inlined, with the dashboard link for the full excerpt and screenshots.
 */
export function buildDescription(input: DescriptionInput): object {
  const content: object[] = [];
  content.push(paragraph(input.summaryLine));

  content.push(heading('Reported by'));
  content.push(bullets([
    `User ${input.reporter.user_id} (${input.reporter.email})`,
    `Environment: ${input.reporter.environment}${input.reporter.platform ? ` · ${input.reporter.platform}` : ''}`,
    `Occurred on: ${input.occurredOn} (IST)`,
    `Feature: ${input.feature}${input.categories.length ? ` — ${input.categories.join(', ')}` : ''}`,
  ]));

  if (input.testerWords) {
    content.push(heading('In the tester’s words'));
    content.push({ type: 'blockquote', content: [paragraph(input.testerWords)] });
  }

  if (input.details.length) {
    content.push(heading('What the tester entered'));
    content.push(bullets(input.details.map(([label, value]) => `${label}: ${value}`)));
  }

  const d = input.diagnosis;
  if (d) {
    content.push(heading('AI diagnosis'));
    const facts = [
      `Most likely cause: ${d.side ?? 'unknown'}${d.confidence === null ? '' : ` (confidence ${Math.round(d.confidence * 100)}%)`}`,
      `Severity: ${d.severity ?? 'unknown'}`,
    ];
    if (d.tags.length) facts.push(`Tags: ${d.tags.join(', ')}`);
    if (d.event_codes.length) facts.push(`Catalog events: ${d.event_codes.join(', ')}`);
    content.push(bullets(facts));
    if (d.summary) content.push(paragraph(d.summary));
    if (d.suggested_fix) {
      content.push(heading('Suggested next step'));
      content.push(paragraph(d.suggested_fix));
    }
    if (d.evidence.length) {
      content.push(heading('Evidence from the logs'));
      content.push(codeBlock(d.evidence.slice(0, 6).map((e) => `[${e.source}${e.ts ? ' ' + e.ts : ''}] ${e.line}`).join('\n')));
    }
    content.push(paragraph('This diagnosis is machine-generated. Treat it as a starting point, not a conclusion.'));
  }

  if (input.kinds.length) {
    content.push(heading('Issue kinds'));
    content.push(bullets(input.kinds));
  }

  if (input.screenshots.length) {
    content.push(heading('Screenshots'));
    content.push(bullets(input.screenshots));
  }

  content.push(heading('Full report'));
  content.push(paragraph(input.dashboardUrl));

  return { type: 'doc', version: 1, content };
}

export class JiraClient {
  private readonly auth: string;

  constructor(private readonly cfg: JiraConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.auth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  }

  get projectKey(): string { return this.cfg.projectKey; }
  get issueType(): string { return this.cfg.issueType; }
  get browseBase(): string { return `${this.cfg.baseUrl.replace(/\/+$/, '')}/browse`; }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { authorization: this.auth, accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
    } catch (err) {
      throw new AppError(502, 'UPSTREAM_ERROR', `Could not reach Jira: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // Jira reports field problems in `errors` and everything else in `errorMessages`.
      let detail = text.slice(0, 500);
      try {
        const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        const parts = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
        if (parts.length) detail = parts.join('; ');
      } catch { /* not JSON; keep the raw body */ }
      const status = res.status === 401 || res.status === 403 ? 502 : res.status === 404 ? 502 : 502;
      throw new AppError(status, 'UPSTREAM_ERROR', `Jira rejected the request (${res.status}): ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Confirms the credentials and the project both work, without creating anything. */
  async check(): Promise<{ ok: true; project: string; name: string | null }> {
    const project = await this.call<{ key: string; name?: string }>(`/rest/api/3/project/${encodeURIComponent(this.cfg.projectKey)}`);
    return { ok: true, project: project.key, name: project.name ?? null };
  }

  async createIssue(input: { summary: string; description: object; labels?: string[] }): Promise<JiraIssue> {
    const created = await this.call<{ key: string }>('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: this.cfg.projectKey },
          issuetype: { name: this.cfg.issueType },
          summary: input.summary.slice(0, 250),
          description: input.description,
          labels: [...new Set([...this.cfg.labels, ...(input.labels ?? [])])].map(jiraLabel).filter(Boolean),
        },
      }),
    });
    return this.getIssue(created.key);
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const issue = await this.call<{
      key: string;
      fields?: { status?: { name?: string }; summary?: string; assignee?: { displayName?: string } | null; updated?: string };
    }>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,summary,assignee,updated`);
    return {
      key: issue.key,
      url: `${this.browseBase}/${issue.key}`,
      status: issue.fields?.status?.name ?? null,
      summary: issue.fields?.summary ?? null,
      assignee: issue.fields?.assignee?.displayName ?? null,
      updated: issue.fields?.updated ?? null,
    };
  }
}

/** Jira labels cannot contain spaces. */
function jiraLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').replace(/[^\w.\-:]/g, '').slice(0, 255);
}

/** The env vars Jira needs, named so the dashboard can show exactly what is missing. */
export const JIRA_REQUIRED_ENV = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'] as const;
