import type { LogFileRef, LogLine, ParsedFile } from './types.js';
import { redact } from './redact.js';

/** Device-local timestamps are treated as IST (UTC+05:30, no DST). */
const IST_OFFSET_MS = 5.5 * 3_600_000;
export function istToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - IST_OFFSET_MS;
}
export function epochToIst(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const MAX_LINE = 400;
const clip = (s: string) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + '…' : s);

// ---------------------------------------------------------------------------
// App logs: JSON API dumps separated by a line of '=' characters, each with "time": "<epoch ms>"
// ---------------------------------------------------------------------------
const APP_SEP = /^={20,}\s*$/m;
const TIME_RE = /"time"\s*:\s*"?(\d{10,13})"?/;

function summarizeAppEntry(chunk: string): { ts: number | null; lines: string[] } {
  const trimmed = chunk.trim();
  if (!trimmed) return { ts: null, lines: [] };
  const tsMatch = TIME_RE.exec(trimmed);
  const ts = tsMatch ? Number(tsMatch[1]!.length === 10 ? tsMatch[1] + '000' : tsMatch[1]) : null;
  let obj: Record<string, unknown> | null = null;
  try { const parsed = JSON.parse(trimmed); if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>; } catch { /* not pure JSON */ }

  if (!obj) {
    // Keep the first meaningful line(s) of non-JSON chunks.
    const firstLines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
    return { ts, lines: firstLines.map(clip) };
  }
  const success = obj.success;
  const message = typeof obj.message === 'string' ? obj.message : '';
  const failed = success === false || obj.error != null || obj.errors != null;
  const data = obj.data;
  const dataKeys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data as object).slice(0, 8) : Array.isArray(data) ? [`array[${data.length}]`] : data == null ? [] : [String(data).slice(0, 40)];
  const head = `${failed ? 'FAIL' : 'ok'} success=${String(success)}${message ? ` message="${message.slice(0, 120)}"` : ''}${dataKeys.length ? ` data:{${dataKeys.join(',')}}` : ''}${obj.is_not_logged ? ' is_not_logged' : ''}`;
  const lines = [clip(head)];
  if (failed) {
    const err = obj.error ?? obj.errors;
    if (err !== undefined) lines.push(clip('error=' + JSON.stringify(err)));
    if (obj.meta !== undefined) lines.push(clip('meta=' + JSON.stringify(obj.meta)));
  }
  return { ts, lines };
}

export function parseAppLog(text: string, ref: LogFileRef): LogLine[] {
  const out: LogLine[] = [];
  let lastTs: number | null = null;
  for (const chunk of text.split(APP_SEP)) {
    const { ts, lines } = summarizeAppEntry(chunk);
    const useTs = ts ?? lastTs;
    for (const l of lines) out.push({ source: 'app', channel: 'app', ts: useTs, approx: ts === null, text: redact(l) });
    if (ts) lastTs = ts;
  }
  void ref;
  return out;
}

// ---------------------------------------------------------------------------
// Ring logs (Android zip members): "YYYY-MM-DD HH:mm:ss:SSS ----> sdk --- area ---> event"
// BLE members are raw protobuf hex; keep only non-payload lines.
// ---------------------------------------------------------------------------
const RING_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}):(\d{3})\s+(.*)$/;
const BLE_PAYLOAD = /(receive|write)\s*=\s*[0-9A-F]{2}(\s[0-9A-F]{2})+/i;

export function parseRingAndroid(text: string, memberName: string): LogLine[] {
  const channel = /BEHAVIOR/i.test(memberName) ? 'ring/BEHAVIOR' : /BLE/i.test(memberName) ? 'ring/BLE' : 'ring';
  const isBle = channel === 'ring/BLE';
  const out: LogLine[] = [];
  let lastTs: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = RING_RE.exec(line);
    let ts: number | null = null;
    let body = line;
    if (m) {
      ts = istToEpoch(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!);
      body = m[8]!;
      lastTs = ts;
    }
    if (isBle && BLE_PAYLOAD.test(body)) continue;
    const compact = body.replace(/^-+>\s*/, '').replace(/-{3,}>/g, '>').replace(/\s{2,}/g, ' ');
    out.push({ source: 'ring', channel, ts: ts ?? lastTs, approx: ts === null, text: redact(clip(compact)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ring logs (iOS watchLogs.txt): SDK trace, almost no timestamps. Session headers give a base time.
// ---------------------------------------------------------------------------
const IOS_HEADER = /log opened at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const IOS_INLINE_TS = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

export function parseRingIos(text: string): LogLine[] {
  const out: LogLine[] = [];
  let base: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = IOS_HEADER.exec(line);
    if (h) { base = istToEpoch(+h[1]!, +h[2]!, +h[3]!, +h[4]!, +h[5]!, +h[6]!); out.push({ source: 'ring', channel: 'ring/ios', ts: base, approx: false, text: clip(line) }); continue; }
    const inl = IOS_INLINE_TS.exec(line);
    const ts = inl ? istToEpoch(+inl[1]!, +inl[2]!, +inl[3]!, +inl[4]!, +inl[5]!, +inl[6]!) : base;
    out.push({ source: 'ring', channel: 'ring/ios', ts, approx: !inl, text: redact(clip(line)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Firmware logs: "M-D HH:mm:ss:frac cmd: 113,17" (no year), sections "==========<epoch ms>=========="
// ---------------------------------------------------------------------------
const FW_RE = /^(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})(?::\d+)?\s+(.*)$/;
const FW_SECTION = /^=+(\d{13})=+\s*$/;

export function parseFirmware(text: string, ref: LogFileRef): LogLine[] {
  const out: LogLine[] = [];
  let year = ref.date ? Number(ref.date.slice(0, 4)) : new Date().getUTCFullYear();
  let lastTs: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const sec = FW_SECTION.exec(line);
    if (sec) { const epoch = Number(sec[1]); year = new Date(epoch + IST_OFFSET_MS).getUTCFullYear(); out.push({ source: 'firmware', channel: 'firmware', ts: epoch, approx: false, text: `--- upload marker ${epochToIst(epoch)} ---` }); lastTs = epoch; continue; }
    const m = FW_RE.exec(line);
    let ts: number | null = null;
    let body = line;
    if (m) { ts = istToEpoch(year, +m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!); body = m[6]!; lastTs = ts; }
    out.push({ source: 'firmware', channel: 'firmware', ts: ts ?? lastTs, approx: ts === null, text: clip(body) });
  }
  return out;
}

// ---------------------------------------------------------------------------

export function parseFetched(ref: LogFileRef, parts: { name: string; text: string }[], bytes: number): ParsedFile {
  const lines: LogLine[] = [];
  const members: string[] = [];
  for (const part of parts) {
    members.push(part.name);
    if (ref.source === 'app') lines.push(...parseAppLog(part.text, ref));
    else if (ref.source === 'firmware') lines.push(...parseFirmware(part.text, ref));
    else if (/watchLogs|ring-trace|\.txt$/i.test(part.name) && !/BEHAVIOR|BLE/i.test(part.name)) lines.push(...parseRingIos(part.text));
    else lines.push(...parseRingAndroid(part.text, part.name));
  }
  return { ref, lines, bytes, members };
}
