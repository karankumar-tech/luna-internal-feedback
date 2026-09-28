import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import { parseSubmissionRef } from '../feedback/feedback.repo.js';
import type { FeedbackRepo } from '../feedback/feedback.repo.js';
import type { KindsService } from '../kinds/kinds.service.js';
import { estimateCost, type ChatMessage, type OpenRouterClient } from '../diagnosis/ai/openrouter.js';
import { compare, isShown, isSuggested, type Match } from './similarity.js';
import type { ReportForMatch, SimilarRepo, StoredVerdict } from './similar.repo.js';

export interface SimilarItem {
  id: string;
  ref: string;
  feature_key: string;
  origin: string;
  environment: string;
  status: string;
  occurred_on: string;
  created_at: string;
  feedback_text: string | null;
  kinds: { id: string; ref: string; title: string }[];
  /** Already confirmed as the same problem as the report being looked at. */
  same_problem: boolean;
  score: number;
  strength: number;
  reasons: Match['reasons'];
  /** For a problem's "find more instances": which of its reports this one resembles most. */
  closest_ref?: string;
  /** The latest AI same-issue check, if one covered this report. */
  ai: { verdict: StoredVerdict['verdict']; reason: string } | null;
}

/** What a new report most likely is, when it looks enough like an open problem. */
export interface LikelyProblem { id: string; ref: string; title: string; report_count: number; strength: number }

const SAME_ISSUE_SCHEMA = {
  name: 'luna_same_issue_check',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['ref', 'verdict', 'reason'],
          properties: {
            ref: { type: 'string', description: 'The candidate report reference, exactly as given (LN-…).' },
            verdict: { type: 'string', enum: ['same', 'related', 'different'] },
            reason: { type: 'string', description: 'One short sentence, at most 140 characters, naming the symptom that matches or differs.' },
          },
        },
      },
    },
  },
} as const;

const VerdictsSchema = z.object({
  verdicts: z.array(z.object({ ref: z.string(), verdict: z.enum(['same', 'related', 'different']), reason: z.string().max(400) })),
});

const SAME_ISSUE_PROMPT = `You decide whether bug reports about Luna, a smart ring and its phone app, describe the same underlying problem, so that duplicates can be grouped and counted.

- same: the same defect — same feature and the same symptom (for example "sleep start recorded hours late"), even when worded differently or reported by different people.
- related: the same area but a different symptom, or too little detail to be sure.
- different: a different problem.

Judge only from what is given. Some reports are a support agent's summary of a customer's message. Give one verdict per candidate, in any order, using the candidate's reference exactly. Reasons are one short sentence, at most 140 characters.`;

/** How many look-alikes the AI check looks at. */
const AI_CHECK_MAX = 12;

export class SimilarService {
  constructor(private readonly d: {
    repo: SimilarRepo;
    feedback: FeedbackRepo;
    kinds: KindsService;
    categories: CategoriesRepo;
    ai: OpenRouterClient | null;
  }) {}

  get aiEnabled(): boolean { return this.d.ai !== null; }

  /** Look-alikes of one report, best first, each with the reasons it matched. */
  async similarTo(idOrRef: string, limit = 20): Promise<{ source: { id: string; ref: string; kinds: ReportForMatch['kinds'] }; items: SimilarItem[]; checked_at: string | null }> {
    const src = await this.source(idOrRef);
    const empty = { source: { id: src.id, ref: src.ref, kinds: src.kinds }, items: [], checked_at: null };
    if (src.is_positive) return empty;

    const [pool, labelOf, check] = await Promise.all([this.d.repo.pool(src), this.labeller(), this.d.repo.latestCheck(src.id)]);
    const cache = new Map<string, Set<string>>();
    const mine = new Set(src.kinds.map((k) => k.id));
    const verdicts = new Map((check?.verdicts ?? []).map((v) => [v.submission_id, v]));

    const items = pool
      .map((c) => ({ c, m: compare(src, c, { labelOf, cache }) }))
      .filter(({ m }) => isShown(m))
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, limit)
      .map(({ c, m }) => this.item(c, m, mine, verdicts.get(c.id)));
    return { ...empty, items, checked_at: check ? new Date(check.created_at).toISOString() : null };
  }

  /** Reports that look like a problem's own reports and are not linked to it yet. */
  async similarToKind(kindIdOrRef: string, isTest: boolean | null, limit = 30): Promise<{ kind: { id: string; ref: string; title: string }; members: number; items: SimilarItem[] }> {
    const kind = await this.d.kinds.get(kindIdOrRef);
    const members = await this.d.repo.members(kind.id, isTest);
    const head = { kind: { id: kind.id, ref: kind.ref, title: kind.title }, members: members.length };
    if (!members.length) return { ...head, items: [] };

    const dates = members.map((m) => m.occurred_on).sort();
    const span = { from: dates[0]!, to: dates[dates.length - 1]! };
    const [pool, labelOf] = await Promise.all([this.d.repo.candidatesForKind(kind.id, isTest, span), this.labeller()]);
    const cache = new Map<string, Set<string>>();
    const best = pool.map((c) => {
      let top: { m: Match; ref: string } | null = null;
      for (const member of members) {
        const m = compare(member, c, { labelOf, cache });
        if (!top || m.score > top.m.score) top = { m, ref: member.ref };
      }
      return { c, top: top! };
    });
    const items = best
      .filter(({ top }) => isShown(top.m))
      .sort((a, b) => b.top.m.score - a.top.m.score)
      .slice(0, limit)
      .map(({ c, top }) => ({ ...this.item(c, top.m, new Set([kind.id]), undefined), closest_ref: top.ref }));
    return { ...head, items };
  }

  /**
   * Proposes the open problem a newly arrived report most likely belongs to, as a suggestion a person
   * confirms. Nothing is proposed for a report already linked to a problem, or for a problem a person
   * has already rejected for it.
   */
  async suggestForNew(submissionId: string): Promise<LikelyProblem | null> {
    const src = await this.d.repo.one(submissionId);
    if (!src || src.is_positive || src.kinds.length) return null;

    const [rows, labelOf] = await Promise.all([this.d.repo.openKindMembers(src.id, src.is_test), this.labeller()]);
    const cache = new Map<string, Set<string>>();
    let best: { kind_id: string; ref: string; title: string; m: Match } | null = null;
    for (const row of rows) {
      const m = compare(src, row, { labelOf, cache });
      if (!best || m.score > best.m.score) best = { kind_id: row.kind_id, ref: row.kind_ref, title: row.kind_title, m };
    }
    if (!best || !isSuggested(best.m)) return null;

    await this.d.kinds.suggestByRule(src.id, best.kind_id, best.m.strength);
    const counts = await this.d.kinds.countsFor([best.kind_id], src.is_test);
    return { id: best.kind_id, ref: best.ref, title: best.title, report_count: counts.get(best.kind_id)?.count ?? 0, strength: best.m.strength };
  }

  /**
   * "These are all the same issue": links the report and the ticked look-alikes to one problem.
   * The problem is the one given, else the report's only problem, else a new one named `title`
   * with this report as its reference.
   */
  async markSame(idOrRef: string, input: { submission_ids: string[]; kind_id?: string; title?: string }, by: string | null) {
    const src = await this.source(idOrRef);
    const others = await this.resolveIds(input.submission_ids.filter((x) => x !== src.id && x !== src.ref));
    const ids = [src.id, ...others.filter((x) => x !== src.id)];

    let target: { kind_id?: string; title?: string; feature_key?: string | null };
    if (input.kind_id) target = { kind_id: input.kind_id };
    else if (src.kinds.length === 1) target = { kind_id: src.kinds[0]!.id };
    else if (src.kinds.length > 1) throw AppError.validation([{ path: 'kind_id', message: `${src.ref} is in more than one problem; say which one` }], 'Which problem?');
    else if (input.title && input.title.trim().length >= 4) target = { title: input.title.trim(), feature_key: src.feature_key };
    else throw AppError.validation([{ path: 'title', message: 'name the new problem (at least 4 characters)' }], 'Name the problem');

    const kind = await this.d.kinds.linkMany(ids, target, by);
    const counts = await this.d.kinds.countsFor([kind.id], src.is_test);
    return { kind: { id: kind.id, ref: kind.ref, title: kind.title }, linked: ids.length, counts: counts.get(kind.id) ?? null };
  }

  /** Links reports to a problem from the problem's side ("find more instances"). */
  async addToKind(kindIdOrRef: string, submissionIds: string[], by: string | null) {
    const ids = await this.resolveIds(submissionIds);
    const kind = await this.d.kinds.linkMany(ids, { kind_id: kindIdOrRef }, by);
    return { kind: { id: kind.id, ref: kind.ref, title: kind.title }, linked: ids.length };
  }

  /** Asks the model which of the top look-alikes are really the same issue. On demand, about $0.002 a call. */
  async aiCheck(idOrRef: string, by: string | null) {
    if (!this.d.ai) throw AppError.validation([{ path: 'ai', message: 'AI is not configured (OPEN_ROUTER_KEY)' }], 'AI unavailable');
    const src = await this.source(idOrRef);
    const found = await this.similarTo(src.id, AI_CHECK_MAX);
    if (!found.items.length) throw AppError.validation([{ path: 'id', message: 'no look-alikes to check' }], 'Nothing to check');

    const [pool, labelOf] = await Promise.all([this.d.repo.pool(src), this.labeller()]);
    const byId = new Map(pool.map((c) => [c.id, c]));
    const candidates = found.items.map((i) => byId.get(i.id)).filter((c): c is ReportForMatch => !!c);

    const describe = (r: ReportForMatch) => [
      `Feature: ${r.feature_key}${r.origin === 'cx' ? ' (filed by customer support for a customer)' : ''}`,
      `Categories: ${r.issue_categories.map((c) => labelOf(r.feature_key, c)).join(', ') || '(none)'}`,
      `Words: ${r.text ? JSON.stringify(r.text.slice(0, 500)) : '(none)'}`,
      `Occurred: ${r.occurred_on} · platform ${r.platform ?? '?'} · app ${r.app_version ?? '?'} · fw ${r.firmware_version ?? '?'}`,
      ...(r.ai_summary ? [`Diagnosis: ${r.ai_summary}`] : []),
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: SAME_ISSUE_PROMPT },
      { role: 'user', content: `# Report ${src.ref}\n${describe(src)}\n\n# Candidates\n${candidates.map((c) => `## ${c.ref}\n${describe(c)}`).join('\n\n')}\n\nReturn one verdict per candidate as JSON.` },
    ];

    const completion = await this.d.ai.completeJson(messages, SAME_ISSUE_SCHEMA, { maxTokens: 1500, temperature: 0 });
    let parsed: z.infer<typeof VerdictsSchema>;
    try { parsed = VerdictsSchema.parse(JSON.parse(completion.text)); }
    catch (err) { throw AppError.validation([{ path: 'ai', message: `the model's answer could not be read (${err instanceof Error ? err.message : String(err)})` }], 'AI check failed'); }

    // Only verdicts about candidates we actually sent are kept.
    const byRef = new Map(candidates.map((c) => [c.ref.toUpperCase(), c]));
    const verdicts: StoredVerdict[] = parsed.verdicts
      .map((v) => ({ v, c: byRef.get(v.ref.trim().toUpperCase()) }))
      .filter((x): x is { v: typeof x.v; c: ReportForMatch } => !!x.c)
      .map(({ v, c }) => ({ submission_id: c.id, ref: c.ref, verdict: v.verdict, reason: v.reason.slice(0, 200) }));
    const cost = completion.costUsd ?? estimateCost(completion.model, completion.promptTokens, completion.completionTokens);
    await this.d.repo.saveCheck({
      submission_id: src.id, verdicts, model: completion.model,
      prompt_tokens: completion.promptTokens, completion_tokens: completion.completionTokens, cost_usd: cost, created_by: by,
    });
    return { ...(await this.similarTo(src.id)), cost_usd: cost };
  }

  // ---------------------------------------------------------------------------

  private async source(idOrRef: string): Promise<ReportForMatch> {
    const [id] = await this.resolveIds([idOrRef]);
    const src = id ? await this.d.repo.one(id) : undefined;
    if (!src) throw AppError.notFound('Submission not found');
    return src;
  }

  /** uuids or references (LN-00042) to uuids; anything that does not exist is refused by name. */
  private async resolveIds(inputs: string[]): Promise<string[]> {
    const uuid = z.string().uuid();
    const out: string[] = [];
    const missing: string[] = [];
    for (const raw of [...new Set(inputs.map((x) => x.trim()))]) {
      if (uuid.safeParse(raw).success) { out.push(raw); continue; }
      const n = parseSubmissionRef(raw);
      const row = n === null ? undefined : await this.d.feedback.byRefNo(n);
      if (row) out.push(row.id); else missing.push(raw);
    }
    const found = await this.d.repo.existing(out);
    for (const id of out) if (!found.has(id)) missing.push(id);
    if (missing.length) throw AppError.validation([{ path: 'submission_ids', message: `not found: ${missing.join(', ')}` }], 'Unknown reports');
    return [...new Set(out)];
  }

  private item(c: ReportForMatch, m: Match, mine: Set<string>, verdict: StoredVerdict | undefined): SimilarItem {
    return {
      id: c.id, ref: c.ref, feature_key: c.feature_key, origin: c.origin, environment: c.environment, status: c.status,
      occurred_on: c.occurred_on, created_at: new Date(c.created_at).toISOString(),
      feedback_text: c.text ? c.text.slice(0, 200) : null,
      kinds: c.kinds, same_problem: c.kinds.some((k) => mine.has(k.id)),
      score: m.score, strength: m.strength, reasons: m.reasons,
      ai: verdict ? { verdict: verdict.verdict, reason: verdict.reason } : null,
    };
  }

  /** Category labels for reasons ("Incorrect sleep" rather than incorrect_sleep), inactive ones included. */
  private async labeller(): Promise<(feature: string, category: string) => string> {
    const features = await this.d.categories.allFeatures();
    const rows = await Promise.all(features.map((f) => this.d.categories.listAll(f.key)));
    const labels = new Map<string, string>();
    rows.flat().forEach((c) => labels.set(`${c.feature_key}|${c.key}`, c.label));
    return (feature, category) => labels.get(`${feature}|${category}`) ?? category;
  }
}
