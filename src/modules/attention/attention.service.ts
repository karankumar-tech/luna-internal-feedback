import type { CommonFilters } from '../feedback/feedback.repo.js';
import type { AttentionRepo, OpenIssueRow } from './attention.repo.js';

/**
 * How long a report may sit before the attention page flags it.
 * Untouched: nobody has done anything with it. Stale: someone did, but nothing has moved since.
 * A customer is waiting behind every CX report, so those are flagged sooner. Critical severity halves both.
 */
export const ATTENTION_THRESHOLDS = {
  cx: { untouched_days: 1, stale_days: 3 },
  internal: { untouched_days: 3, stale_days: 7 },
} as const;

/** A problem with this many reports deserves its own Jira ticket; any CX report qualifies on its own. */
export const KIND_TICKET_MIN_REPORTS = 5;

/** A diagnosis still waiting for logs after this long is worth a look. */
const WAITING_LOGS_STUCK_DAYS = 2;

const SECTION_LIMIT = 25;
const AGE_BUCKETS = [
  { key: '0-2d', max: 3 }, { key: '3-7d', max: 8 }, { key: '8-14d', max: 15 }, { key: '15-30d', max: 31 }, { key: '30d+', max: Infinity },
] as const;
const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface AttentionItem {
  id: string;
  ref: string;
  feature_key: string;
  origin: 'internal' | 'cx';
  environment: string;
  status: string;
  created_at: string;
  age_days: number;
  idle_days: number;
  severity: string | null;
  ai_status: string | null;
  cx_ref: string | null;
  feedback_text: string | null;
  kinds: { ref: string; title: string }[];
  /** How far past its threshold it is, in days (0 when the section has no threshold). */
  overdue_days: number;
  /** Sort key: severity × (1 + log2(people affected)) × (1 + age / 7). Parts are returned so the page can explain it. */
  score: number;
  score_parts: { severity: number; impact: number; age_days: number };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function thresholdsFor(row: OpenIssueRow) {
  const t = ATTENTION_THRESHOLDS[row.origin];
  const factor = row.ai_severity === 'critical' ? 0.5 : 1;
  return { untouched: t.untouched_days * factor, stale: t.stale_days * factor };
}

function score(row: OpenIssueRow) {
  const severity = SEVERITY_WEIGHT[row.ai_severity ?? ''] ?? 2;
  const impact = Math.max(row.impact, 1);
  const age = Math.min(row.age_days, 30);
  return { value: severity * (1 + Math.log2(impact)) * (1 + age / 7), parts: { severity, impact, age_days: round1(row.age_days) } };
}

function toItem(row: OpenIssueRow, overdue: number): AttentionItem {
  const s = score(row);
  return {
    id: row.id, ref: row.ref, feature_key: row.feature_key, origin: row.origin, environment: row.environment, status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    age_days: round1(row.age_days), idle_days: round1(row.idle_days),
    severity: row.ai_severity, ai_status: row.ai_status, cx_ref: row.cx_ref, feedback_text: row.feedback_text,
    kinds: row.kinds ?? [],
    overdue_days: round1(Math.max(overdue, 0)),
    score: round1(s.value), score_parts: s.parts,
  };
}

/** Highest score first; CX before internal on a tie, since a customer is waiting. */
function byPriority(a: AttentionItem, b: AttentionItem): number {
  return b.score - a.score || (a.origin === b.origin ? 0 : a.origin === 'cx' ? -1 : 1) || b.age_days - a.age_days;
}

function section(items: AttentionItem[]) {
  const sorted = [...items].sort(byPriority);
  return { total: sorted.length, items: sorted.slice(0, SECTION_LIMIT) };
}

export class AttentionService {
  constructor(private readonly repo: AttentionRepo) {}

  /** Everything someone should look at now, in one read. Not windowed by date: an old open report is exactly the point. */
  async overview(filters: Partial<CommonFilters>) {
    const [rows, kinds] = await Promise.all([
      this.repo.openIssues(filters),
      this.repo.kindsWithoutJira(filters, KIND_TICKET_MIN_REPORTS),
    ]);

    const untouched: AttentionItem[] = [];
    const stale: AttentionItem[] = [];
    const cxWaiting: AttentionItem[] = [];
    const diagnosisStuck: AttentionItem[] = [];
    const buckets = new Map<string, number>();

    for (const row of rows) {
      const t = thresholdsFor(row);
      if (row.untouched && row.age_days >= t.untouched) untouched.push(toItem(row, row.age_days - t.untouched));
      if (!row.untouched && row.idle_days >= t.stale) stale.push(toItem(row, row.idle_days - t.stale));
      if (row.origin === 'cx') cxWaiting.push(toItem(row, row.age_days - t.untouched));
      if (row.ai_status === 'failed' || (row.ai_status === 'waiting_logs' && row.age_days >= WAITING_LOGS_STUCK_DAYS)) diagnosisStuck.push(toItem(row, 0));

      const bucket = AGE_BUCKETS.find((b) => row.age_days < b.max)!.key;
      const key = `${row.origin}|${bucket}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const sections = {
      untouched: section(untouched),
      cx_waiting: section(cxWaiting),
      stale: section(stale),
      diagnosis_stuck: section(diagnosisStuck),
    };
    return {
      generated_at: new Date().toISOString(),
      thresholds: { ...ATTENTION_THRESHOLDS, critical_factor: 0.5, kind_ticket_min_reports: KIND_TICKET_MIN_REPORTS },
      counts: {
        open: rows.length,
        untouched: sections.untouched.total,
        cx_waiting: sections.cx_waiting.total,
        stale: sections.stale.total,
        diagnosis_stuck: sections.diagnosis_stuck.total,
        kinds_without_jira: kinds.length,
      },
      sections,
      kinds_without_jira: kinds,
      age_buckets: (['cx', 'internal'] as const).flatMap((origin) =>
        AGE_BUCKETS.map((b) => ({ origin, bucket: b.key, count: buckets.get(`${origin}|${b.key}`) ?? 0 }))),
    };
  }
}
