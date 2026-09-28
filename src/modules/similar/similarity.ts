/**
 * "Is this the same problem?" as a transparent score between two reports.
 *
 * Every signal is something a person can check at a glance, and each one that contributes is
 * returned as a reason, so the dashboard can say why two reports matched instead of showing a
 * bare number. Pure functions: the service feeds them rows, the tests feed them literals.
 */

export interface Comparable {
  id: string;
  feature_key: string;
  issue_categories: string[];
  /** AI tags from the report's diagnosis, if it has one. */
  tags: string[];
  /** Catalog event codes the diagnosis matched (FW-01, RL-07, ...). */
  event_codes: string[];
  text: string | null;
  firmware_version: string | null;
  app_version: string | null;
  platform: string | null;
  /** YYYY-MM-DD */
  occurred_on: string;
}

export type ReasonKind = 'feature' | 'categories' | 'tags' | 'events' | 'text' | 'firmware' | 'app' | 'platform';
export interface Reason { kind: ReasonKind; label: string }

export interface Match {
  /** Sum of the weighted signals, less the date penalty. */
  score: number;
  /** score as a share of the best possible score, 0..1, for display. */
  strength: number;
  /** True when something beyond "same screen, same build" lines up: categories, tags, events or wording. */
  substantive: boolean;
  /** How many of those symptom signals line up (categories, wording, diagnosis tags, catalog events). */
  signals: number;
  reasons: Reason[];
}

/**
 * Firmware, app version and platform are tie-breakers: most testers run the same build on the
 * same phone, so a shared build says little about whether two reports are the same problem.
 */
export const WEIGHTS = { feature: 3, categories: 2, tags: 2, events: 3, text: 2, firmware: 0.5, app: 0.5, platform: 0.25 } as const;

/** "None of the above" categories: two reports both picking one says nothing about a shared symptom. */
export const CATCH_ALL_CATEGORIES: ReadonlySet<string> = new Set(['something_else']);
const BEST = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

/** Wording below this trigram similarity is noise; at TEXT_FULL and above it earns the full text weight. */
export const TEXT_MIN = 0.2;
const TEXT_FULL = 0.5;
/** Up to one point is lost as the reports' dates drift apart, reaching the full penalty at this many days. */
const DATE_SPAN_DAYS = 30;

/** Shown in the "Similar reports" panel, where a person decides. */
export const SHOW_MIN_SCORE = 3.5;
/**
 * Proposed automatically as "Looks like: …" on a new report. Needs this score and at least two
 * symptom signals agreeing (say, the same category and similar wording): a shared category on the
 * same build is not enough on its own.
 */
export const SUGGEST_MIN_SCORE = 6;
export const SUGGEST_MIN_SIGNALS = 2;

/** Trigrams the way Postgres pg_trgm builds them: lowercase words, padded with two spaces before and one after. */
export function trigrams(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Shared trigrams over all trigrams, as pg_trgm's similarity(). 0 when either side is empty. */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined, cache?: Map<string, Set<string>>): number {
  const ta = cachedTrigrams(a, cache);
  const tb = cachedTrigrams(b, cache);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (large.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function cachedTrigrams(text: string | null | undefined, cache?: Map<string, Set<string>>): Set<string> {
  if (!text) return new Set();
  if (!cache) return trigrams(text);
  let t = cache.get(text);
  if (!t) { t = trigrams(text); cache.set(text, t); }
  return t;
}

function jaccard(a: readonly string[], b: readonly string[]): { value: number; shared: string[] } {
  if (!a.length || !b.length) return { value: 0, shared: [] };
  const sb = new Set(b);
  const shared = [...new Set(a)].filter((x) => sb.has(x));
  const union = new Set([...a, ...b]).size;
  return { value: shared.length / union, shared };
}

function dayGap(a: string, b: string): number {
  return Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * How much `b` looks like the same problem as `a`. Symmetric apart from the labels, which come from `labelOf`.
 * `cache` holds trigram sets when one report is compared against many.
 */
export function compare(
  a: Comparable,
  b: Comparable,
  opts: { labelOf?: (feature: string, category: string) => string; cache?: Map<string, Set<string>> } = {},
): Match {
  const reasons: Reason[] = [];
  let score = 0;
  let signals = 0;

  if (a.feature_key === b.feature_key) { score += WEIGHTS.feature; reasons.push({ kind: 'feature', label: 'same feature' }); }

  const specific = (cs: string[]) => cs.filter((c) => !CATCH_ALL_CATEGORIES.has(c));
  const cats = jaccard(specific(a.issue_categories), specific(b.issue_categories));
  if (cats.value > 0 && a.feature_key === b.feature_key) {
    score += WEIGHTS.categories * cats.value;
    signals += 1;
    const label = opts.labelOf ? cats.shared.map((c) => opts.labelOf!(a.feature_key, c)) : cats.shared;
    reasons.push({ kind: 'categories', label: label.join(', ') });
  }

  const tags = jaccard(a.tags, b.tags);
  if (tags.value > 0) { score += WEIGHTS.tags * tags.value; signals += 1; reasons.push({ kind: 'tags', label: tags.shared.join(', ') }); }

  const events = jaccard(a.event_codes, b.event_codes);
  if (events.shared.length) { score += WEIGHTS.events; signals += 1; reasons.push({ kind: 'events', label: events.shared.join(', ') }); }

  const text = textSimilarity(a.text, b.text, opts.cache);
  if (text >= TEXT_MIN) {
    score += WEIGHTS.text * Math.min(1, text / TEXT_FULL);
    signals += 1;
    reasons.push({ kind: 'text', label: `wording ${Math.round(text * 100)}% alike` });
  }

  if (a.firmware_version && a.firmware_version === b.firmware_version) { score += WEIGHTS.firmware; reasons.push({ kind: 'firmware', label: `fw ${a.firmware_version}` }); }
  if (a.app_version && a.app_version === b.app_version) { score += WEIGHTS.app; reasons.push({ kind: 'app', label: `app ${a.app_version}` }); }
  if (a.platform && a.platform === b.platform) { score += WEIGHTS.platform; reasons.push({ kind: 'platform', label: a.platform === 'ios' ? 'iOS' : a.platform === 'android' ? 'Android' : a.platform }); }

  score -= Math.min(dayGap(a.occurred_on, b.occurred_on), DATE_SPAN_DAYS) / DATE_SPAN_DAYS;

  return { score: round(score), strength: round(Math.max(0, score) / BEST), substantive: signals > 0, signals, reasons };
}

/** Worth showing as a look-alike. */
export function isShown(m: Match): boolean {
  return m.substantive && m.score >= SHOW_MIN_SCORE;
}

/** Strong enough to propose on its own when a report arrives. */
export function isSuggested(m: Match): boolean {
  return m.signals >= SUGGEST_MIN_SIGNALS && m.score >= SUGGEST_MIN_SCORE;
}
