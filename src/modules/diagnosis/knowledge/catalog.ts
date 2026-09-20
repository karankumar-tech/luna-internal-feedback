import { CATALOG } from './catalog.generated.js';
import type { Catalog, CatalogDictionaryEntry, CatalogEvent } from './types.js';

export type { Catalog, CatalogEvent, CatalogDictionaryEntry };
export { CATALOG };

export const EVENTS_BY_ID = new Map(CATALOG.events.map((e) => [e.id, e]));

/** Valid event codes, so a model that invents one cannot pollute the analytics. */
export function isKnownEventCode(code: string): boolean {
  return EVENTS_BY_ID.has(code.trim().toUpperCase());
}

export interface CatalogHit<T> {
  entry: T;
  /** Probes that fired, longest first. */
  hits: string[];
  /** Line numbers (1-based, within the excerpt) where the first hit landed. */
  lines: number[];
  score: number;
}

export interface MatchResult {
  events: CatalogHit<CatalogEvent>[];
  dictionary: CatalogHit<CatalogDictionaryEntry>[];
}

interface Probe<T> { text: string; entry: T; }

/** Built once per process: every probe lower-cased, longest first so the best hit wins. */
const EVENT_PROBES: Probe<CatalogEvent>[] = [];
const DICT_PROBES: Probe<CatalogDictionaryEntry>[] = [];
for (const entry of CATALOG.events) for (const text of entry.match) EVENT_PROBES.push({ text: text.toLowerCase(), entry });
for (const entry of CATALOG.dictionary) for (const text of entry.match) DICT_PROBES.push({ text: text.toLowerCase(), entry });

const PRIORITY_WEIGHT: Record<string, number> = { P0: 1.6, P1: 1.2, P2: 1 };

/** Longer, rarer fragments are stronger evidence than short ones. */
function probeWeight(text: string): number {
  return Math.min(text.length, 40) / 40;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function collect<T>(probes: Probe<T>[], blob: string, starts: number[], weightOf: (entry: T) => number): CatalogHit<T>[] {
  const byEntry = new Map<T, CatalogHit<T>>();
  for (const probe of probes) {
    const at = blob.indexOf(probe.text);
    if (at < 0) continue;
    let hit = byEntry.get(probe.entry);
    if (!hit) { hit = { entry: probe.entry, hits: [], lines: [], score: 0 }; byEntry.set(probe.entry, hit); }
    hit.hits.push(probe.text);
    hit.lines.push(lineAt(starts, at));
    hit.score += probeWeight(probe.text);
  }
  const out = [...byEntry.values()];
  for (const hit of out) {
    hit.score *= weightOf(hit.entry);
    hit.hits.sort((a, b) => b.length - a.length);
    hit.lines = [...new Set(hit.lines)].sort((a, b) => a - b).slice(0, 4);
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Finds the catalog entries an excerpt actually contains.
 *
 * Whole-excerpt substring search rather than line-by-line: one pass per probe over a
 * lower-cased blob, then the offset is mapped back to a line number. ~1400 probes over a
 * 30 KB excerpt costs a few milliseconds, which is nothing next to the model call.
 */
export function matchCatalog(excerpt: string, limits: { events?: number; dictionary?: number } = {}): MatchResult {
  const blob = excerpt.toLowerCase();
  const starts = lineStarts(blob);
  const events = collect(EVENT_PROBES, blob, starts, (e) => PRIORITY_WEIGHT[e.priority ?? ''] ?? 1);
  const dictionary = collect(DICT_PROBES, blob, starts, () => 1);
  return {
    events: events.slice(0, limits.events ?? 14),
    // A dictionary line whose event is already listed adds nothing.
    dictionary: dictionary.slice(0, limits.dictionary ?? 18),
  };
}

const MAX_BRIEF_CHARS = 7000;

/**
 * Renders matched entries for the prompt. Compact on purpose: this rides along with the
 * excerpt on every diagnosis, so it is capped in entries and again in characters.
 */
export function renderCatalogBrief(match: MatchResult): string {
  if (!match.events.length && !match.dictionary.length) return '';
  const out: string[] = [];

  if (match.events.length) {
    out.push('## Known critical events matched in the excerpt');
    out.push('Use the id as an event code when the evidence fits. Severity here is the catalog\'s grading, not yours.');
    for (const { entry, hits, lines } of match.events) {
      const head = [
        `[${entry.id}]`,
        entry.event,
        entry.reasons.length ? `reasons: ${entry.reasons.join(' | ')}` : '',
        entry.priority ?? '',
        entry.domain,
        entry.severity ?? '',
        entry.tag ? `tag=${entry.tag}` : '',
      ].filter(Boolean).join(' · ');
      out.push(head);
      if (entry.means) out.push(`   means: ${entry.means}`);
      if (entry.detect) out.push(`   detect: ${entry.detect}`);
      out.push(`   matched: ${hits.slice(0, 2).map((h) => JSON.stringify(h)).join(', ')} (line ${lines.join(', ')})`);
    }
  }

  if (match.dictionary.length) {
    out.push('');
    out.push('## Vendor log dictionary for lines in the excerpt');
    for (const { entry } of match.dictionary) out.push(`- [${entry.source}] ${entry.fn} — ${entry.desc}`);
  }

  const text = out.join('\n');
  return text.length <= MAX_BRIEF_CHARS ? text : text.slice(0, MAX_BRIEF_CHARS) + '\n… (catalog list truncated)';
}
