import type { LogLine, LogSource, ParsedFile } from './logs/types.js';
import { epochToIst, istToEpoch } from './logs/parse.js';

export interface WindowSpec { from: number; to: number; label: string }

export interface ExcerptResult {
  excerpt: string;
  lineCount: number;
  coverage: 'full' | 'partial' | 'none';
  window: WindowSpec;
  perSource: Record<LogSource, number>;
}

const CAPS: Record<LogSource, number> = { app: 40, ring: 40, firmware: 20 };
const TOTAL_CAP = 100;

const GENERIC = /\b(error|fail|failed|failure|timeout|timed out|disconnect|disconnected|retry|exception|crash|reboot|reset|battery|abort|denied|unauthori[sz]ed|invalid|missing|null|not found|refused|lost|stuck|frozen|hang)\b/i;
const FEATURE_WORDS: Record<string, RegExp> = {
  sleep: /\b(sleep|stage|hrv|spo2|vital|nap|bed|wake|night)\b/i,
  workout: /\b(workout|exercise|hr|heart|gps|map|zone|intensity|start|stop|end|calorie)\b/i,
  activity: /\b(step|steps|calorie|calories|load|training|active|daily)\b/i,
  home: /\b(peak|score|guidance|insight|brief|home)\b/i,
  other: /\b(login|otp|auth|token|pair|bond|connect|sync|update|ota|permission|notification)\b/i,
};
const STATUS = /\b(4\d\d|5\d\d)\b|status\s*[:=]\s*"?(4|5)\d\d/;

/** Parse "HH:MM AM/PM" into minutes from midnight; null when malformed. */
function timeToMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(v.trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

/**
 * The IST window to search. Whole issue day by default; sleep and workout narrow it using the
 * times the tester gave (sleep windows that end before they start are treated as crossing midnight).
 */
export function computeWindow(feature: string, occurredOn: string, details: Record<string, unknown>): WindowSpec {
  const [y, mo, d] = occurredOn.split('-').map(Number) as [number, number, number];
  const dayStart = istToEpoch(y, mo, d, 0, 0, 0);
  const dayEnd = dayStart + 86_400_000 - 1;
  const at = (min: number, dayOffset = 0) => dayStart + dayOffset * 86_400_000 + min * 60_000;

  if (feature === 'sleep') {
    const starts = [timeToMinutes(details.actual_start_time), timeToMinutes(details.recorded_start_time)].filter((x): x is number => x !== null);
    const ends = [timeToMinutes(details.actual_end_time), timeToMinutes(details.recorded_end_time)].filter((x): x is number => x !== null);
    if (starts.length || ends.length) {
      const start = starts.length ? Math.min(...starts) : 21 * 60;
      const end = ends.length ? Math.max(...ends) : 9 * 60;
      // A sleep that starts in the evening and ends in the morning crosses midnight: start is the *previous* evening.
      const crosses = end <= start;
      const from = crosses ? at(start, -1) : at(start);
      const to = at(end);
      return { from: from - 3_600_000, to: to + 3_600_000, label: 'sleep window ±1h' };
    }
    return { from: dayStart - 6 * 3_600_000, to: dayEnd, label: 'issue day incl. previous evening' };
  }
  if (feature === 'workout') {
    const start = timeToMinutes(details.start_time);
    const end = timeToMinutes(details.end_time);
    if (start !== null) {
      const from = at(start) - 30 * 60_000;
      const to = end !== null && end > start ? at(end) + 30 * 60_000 : at(start) + 3 * 3_600_000;
      return { from, to, label: 'workout window ±30m' };
    }
  }
  return { from: dayStart, to: dayEnd, label: 'issue day' };
}

function scoreLine(line: LogLine, feature: string, win: WindowSpec): number {
  let s = 0;
  if (GENERIC.test(line.text)) s += 3;
  if (STATUS.test(line.text)) s += 2;
  const fw = FEATURE_WORDS[feature];
  if (fw && fw.test(line.text)) s += 2;
  if (line.text.startsWith('FAIL')) s += 3;
  if (line.ts === null) return s > 0 ? s : 0;
  if (line.ts >= win.from && line.ts <= win.to) s += 2;
  else {
    const dist = Math.min(Math.abs(line.ts - win.from), Math.abs(line.ts - win.to));
    if (dist <= 6 * 3_600_000) s += 1;
    else if (dist > 36 * 3_600_000) return -1; // far outside: never include
  }
  return s;
}

interface Scored { line: LogLine; idx: number; score: number }

function selectForSource(lines: LogLine[], feature: string, win: WindowSpec, cap: number): LogLine[] {
  if (lines.length === 0) return [];
  const scored: Scored[] = lines.map((line, idx) => ({ line, idx, score: scoreLine(line, feature, win) })).filter((x) => x.score >= 0);
  const inWindow = (x: Scored) => x.line.ts !== null && x.line.ts >= win.from && x.line.ts <= win.to;

  // 1) strongest hits, 2) context around the top few, 3) fill with in-window lines nearest the window centre.
  const hits = scored.filter((x) => x.score >= 3).sort((a, b) => b.score - a.score || b.idx - a.idx);
  const chosen = new Map<number, LogLine>();
  for (const h of hits.slice(0, cap)) chosen.set(h.idx, h.line);
  for (const h of hits.slice(0, 6)) {
    for (const off of [-2, -1, 1, 2]) {
      const j = h.idx + off;
      if (j >= 0 && j < lines.length && chosen.size < cap && scored.find((x) => x.idx === j)) chosen.set(j, lines[j]!);
    }
  }
  if (chosen.size < cap) {
    const centre = (win.from + win.to) / 2;
    const fill = scored.filter((x) => !chosen.has(x.idx) && (inWindow(x) || x.line.ts === null))
      .sort((a, b) => b.score - a.score || Math.abs((a.line.ts ?? centre) - centre) - Math.abs((b.line.ts ?? centre) - centre));
    for (const f of fill) { if (chosen.size >= cap) break; chosen.set(f.idx, f.line); }
  }
  return [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
}

function fmt(line: LogLine): string {
  const t = line.ts === null ? '        ' : epochToIst(line.ts).slice(11) + (line.approx ? '~' : ' ');
  return `${t} ${line.text}`;
}

/**
 * Build the ≤100-line merged excerpt. Sections are separated by a tag line so the model (and a
 * human) can tell the sources apart; lines inside a section are chronological.
 */
export function buildExcerpt(
  files: ParsedFile[],
  opts: { feature: string; occurredOn: string; details: Record<string, unknown>; fwVersion?: string | null; appVersion?: string | null },
): ExcerptResult {
  const win = computeWindow(opts.feature, opts.occurredOn, opts.details);
  const bySource: Record<LogSource, LogLine[]> = { app: [], ring: [], firmware: [] };
  for (const f of files) bySource[f.ref.source].push(...f.lines);

  const selected: Record<LogSource, LogLine[]> = {
    app: selectForSource(bySource.app, opts.feature, win, CAPS.app),
    ring: selectForSource(bySource.ring, opts.feature, win, CAPS.ring),
    firmware: selectForSource(bySource.firmware, opts.feature, win, CAPS.firmware),
  };

  // Enforce the global cap by trimming the largest section first.
  let total = selected.app.length + selected.ring.length + selected.firmware.length;
  const sepCount = 3;
  while (total + sepCount > TOTAL_CAP) {
    const biggest = (['app', 'ring', 'firmware'] as LogSource[]).sort((a, b) => selected[b].length - selected[a].length)[0]!;
    selected[biggest].pop();
    total -= 1;
  }

  const anyLines = bySource.app.length + bySource.ring.length + bySource.firmware.length > 0;
  const anyInWindow = (['app', 'ring', 'firmware'] as LogSource[]).some((s) => bySource[s].some((l) => l.ts !== null && l.ts >= win.from && l.ts <= win.to));
  const coverage: ExcerptResult['coverage'] = !anyLines ? 'none' : anyInWindow ? 'full' : 'partial';

  const header = (s: LogSource, extra: string) => `===== [${s}]${extra ? ' ' + extra : ''} =====`;
  const parts: string[] = [];
  parts.push(header('app', opts.appVersion ? `app ${opts.appVersion}` : ''));
  parts.push(...(selected.app.length ? selected.app.map(fmt) : ['(no app log lines for this window)']));
  parts.push(header('ring', ''));
  parts.push(...(selected.ring.length ? selected.ring.map((l) => fmt(l).replace(/^(\S+\s)/, `$1[${l.channel.replace('ring/', '')}] `)) : ['(no ring log lines for this window)']));
  parts.push(header('firmware', opts.fwVersion ? `fv ${opts.fwVersion}` : ''));
  parts.push(...(selected.firmware.length ? selected.firmware.map(fmt) : ['(no firmware log lines for this window)']));

  return {
    excerpt: parts.join('\n'),
    lineCount: parts.length,
    coverage,
    window: win,
    perSource: { app: selected.app.length, ring: selected.ring.length, firmware: selected.firmware.length },
  };
}
