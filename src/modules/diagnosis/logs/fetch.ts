import { unzipSync } from 'fflate';
import type { LogFileRef } from './types.js';

export interface FetchedFile {
  ref: LogFileRef;
  bytes: number;
  /** Text blobs to parse: a plain file yields one; a zip yields one per selected member. */
  parts: { name: string; text: string }[];
}

export interface FetchOptions {
  maxBytes?: number;      // per file, default 25 MB
  timeoutMs?: number;     // default 60 s
  fetchImpl?: typeof fetch;
  /** For zips: keep members whose name contains one of these dates, or (when empty) every member. */
  memberDates?: string[];
  /** For zips: drop members whose name matches (e.g. raw BLE hex dumps). */
  skipMember?: (name: string) => boolean;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export async function fetchLogFile(ref: LogFileRef, opts: FetchOptions = {}): Promise<FetchedFile> {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetchImpl(ref.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download failed ${res.status} for ${ref.url}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`file too large (${declared} bytes) ${ref.url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`file too large (${buf.byteLength} bytes) ${ref.url}`);

    const isZip = /\.zip(\?|$)/i.test(ref.url) || (buf[0] === 0x50 && buf[1] === 0x4b);
    if (!isZip) return { ref, bytes: buf.byteLength, parts: [{ name: ref.url.split('/').pop() || 'file', text: decoder.decode(buf) }] };

    const dates = opts.memberDates ?? [];
    const files = unzipSync(buf, {
      filter: (file) => {
        if (opts.skipMember?.(file.name)) return false;
        if (dates.length === 0) return true;
        return dates.some((d) => file.name.includes(d));
      },
    });
    const parts = Object.entries(files).map(([name, data]) => ({ name, text: decoder.decode(data) }));
    return { ref, bytes: buf.byteLength, parts };
  } finally {
    clearTimeout(timer);
  }
}
