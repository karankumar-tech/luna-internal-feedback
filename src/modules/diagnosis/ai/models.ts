import { AppError } from '../../../lib/errors.js';

/** One model OpenRouter offers, trimmed to what Settings shows and checks. */
export interface ModelInfo {
  id: string;
  name: string;
  context_length: number | null;
  /** USD per million input / output tokens; null when OpenRouter prices it some other way (routers). */
  input_per_m: number | null;
  output_per_m: number | null;
  /** Reads images, so a diagnosis can send the report's screenshots. */
  images: boolean;
  /** Answers against a JSON schema (`structured_outputs`), which a diagnosis and the issue matcher need. */
  structured: boolean;
  /** The day OpenRouter will retire it, when it says. */
  expires: string | null;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  expiration_date?: unknown;
}

/** The list changes a few times a week; an hour old is fresh enough to pick from. */
const TTL_MS = 60 * 60_000;

const perMillion = (v: unknown): number | null => {
  const n = Number(v);
  return typeof v === 'string' && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toModelInfo(m: RawModel): ModelInfo | null {
  if (typeof m.id !== 'string' || !m.id) return null;
  // Only models that answer in text can diagnose or chat.
  const out = strings(m.architecture?.output_modalities);
  if (out.length && !out.includes('text')) return null;
  return {
    id: m.id,
    name: typeof m.name === 'string' && m.name ? m.name : m.id,
    context_length: typeof m.context_length === 'number' ? m.context_length : null,
    input_per_m: perMillion(m.pricing?.prompt),
    output_per_m: perMillion(m.pricing?.completion),
    images: strings(m.architecture?.input_modalities).includes('image'),
    structured: strings(m.supported_parameters).includes('structured_outputs'),
    expires: typeof m.expiration_date === 'string' && m.expiration_date ? m.expiration_date : null,
  };
}

/**
 * The models OpenRouter offers (GET /api/v1/models, public), held for an hour. If a refresh fails,
 * the list already held keeps answering; with none held, the caller gets an upstream error.
 */
export class OpenRouterCatalog {
  private held: { models: ModelInfo[]; fetchedAt: number } | undefined;
  private inflight: Promise<{ models: ModelInfo[]; fetchedAt: number }> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) { this.fetchImpl = opts.fetchImpl ?? fetch; }

  private async load(): Promise<{ models: ModelInfo[]; fetchedAt: number }> {
    const res = await this.fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!res.ok || !body || !Array.isArray(body.data)) throw new Error(`OpenRouter's model list answered ${res.status}`);
    const models = (body.data as RawModel[]).map(toModelInfo).filter((m): m is ModelInfo => m !== null);
    if (!models.length) throw new Error("OpenRouter's model list was empty");
    return { models, fetchedAt: Date.now() };
  }

  /** Every model, in OpenRouter's order (newest first), and when the list was fetched. */
  async list(): Promise<{ models: ModelInfo[]; fetched_at: string }> {
    const held = this.held;
    if (!held || Date.now() - held.fetchedAt >= TTL_MS) {
      if (!this.inflight) {
        this.inflight = this.load()
          .then((l) => { this.held = l; return l; })
          .finally(() => { this.inflight = undefined; });
      }
      try { await this.inflight; }
      catch (err) {
        if (!held) throw AppError.upstream(`Could not get OpenRouter's model list: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const l = this.held ?? held!;
    return { models: l.models, fetched_at: new Date(l.fetchedAt).toISOString() };
  }

  async find(id: string): Promise<ModelInfo | null> {
    return (await this.list()).models.find((m) => m.id === id) ?? null;
  }
}
