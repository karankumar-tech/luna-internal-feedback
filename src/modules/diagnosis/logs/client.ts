import type { LogDeviceEntry, LogFileRef, LogSource } from './types.js';

export interface LogsClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DATE_IN_PATH = /\/\d+-(\d{4}-\d{2}-\d{2})\//;

function splitUrls(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
}

export function toFileRefs(source: LogSource, value: unknown): LogFileRef[] {
  return splitUrls(value).map((url) => ({ source, url, date: DATE_IN_PATH.exec(url)?.[1] ?? null }));
}

function str(v: unknown): string | null { return typeof v === 'string' && v !== '' ? v : v == null ? null : String(v); }
function num(v: unknown): number | null { return typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null; }

export function normalizeEntry(raw: Record<string, unknown>): LogDeviceEntry {
  return {
    user_id: num(raw.user_id),
    device_id: num(raw.device_id),
    platform: str(raw.platform)?.toLowerCase() ?? null,
    device_model: str(raw.device_model),
    device_manufacturer: str(raw.device_manufacturer),
    os_version: str(raw.os_version),
    fv: str(raw.fv),
    version_name: str(raw.version_name),
    batt_perct: num(raw.batt_perct),
    updated_at: str(raw.updated_at),
    files: {
      app: toFileRefs('app', raw.app_logs),
      ring: toFileRefs('ring', raw.ring_logs),
      firmware: toFileRefs('firmware', raw.firmware_logs),
    },
  };
}

export class LogsApiError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'LogsApiError'; }
}

/** Thin client for the Luna logging API (`list-botfetch`). */
export class LogsClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: LogsClientOptions) { this.fetchImpl = opts.fetchImpl ?? fetch; }

  async listBySerial(serial: string): Promise<LogDeviceEntry[]> { return this.list({ serial_no: serial }); }
  async listByEmail(email: string): Promise<LogDeviceEntry[]> { return this.list({ email }); }

  private async list(params: Record<string, string>): Promise<LogDeviceEntry[]> {
    const url = new URL('/logging/ring/list-botfetch', this.opts.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'api-key': this.opts.apiKey, Host: url.host, accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new LogsApiError(`logs API responded ${res.status}`, res.status);
      const body = (await res.json()) as { success?: boolean; data?: unknown; message?: string };
      if (body.success === false) throw new LogsApiError(body.message || 'logs API returned success=false');
      const data = Array.isArray(body.data) ? body.data : [];
      return data.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object').map(normalizeEntry);
    } finally {
      clearTimeout(timer);
    }
  }
}
