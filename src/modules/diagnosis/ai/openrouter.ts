export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

export interface CompletionResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** USD as reported by OpenRouter (usage.cost); null when not returned. */
  costUsd: number | null;
  durationMs: number;
  raw?: unknown;
}

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  referer?: string;
  title?: string;
}

export class OpenRouterError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) { super(message); this.name = 'OpenRouterError'; }
}

/** Minimal chat-completions client. One call per diagnosis, or per chat follow-up. */
export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: OpenRouterOptions) { this.fetchImpl = opts.fetchImpl ?? fetch; }

  get model(): string { return this.opts.model; }

  /** Structured output against a JSON schema: how a diagnosis verdict is produced. */
  completeJson(messages: ChatMessage[], jsonSchema: unknown, params: { maxTokens?: number; temperature?: number; model?: string } = {}): Promise<CompletionResult> {
    return this.post(messages, { ...params, responseFormat: { type: 'json_schema', json_schema: jsonSchema } });
  }

  /** Plain prose: how the per-ticket follow-up chat answers. */
  complete(messages: ChatMessage[], params: { maxTokens?: number; temperature?: number; model?: string } = {}): Promise<CompletionResult> {
    return this.post(messages, params);
  }

  private async post(
    messages: ChatMessage[],
    params: { maxTokens?: number; temperature?: number; model?: string; responseFormat?: unknown },
  ): Promise<CompletionResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 90_000);
    const started = Date.now();
    const model = params.model ?? this.opts.model;
    try {
      const res = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'http-referer': this.opts.referer ?? 'https://luna-feedback.buildsage.tech',
          'x-title': this.opts.title ?? 'Luna Feedback Diagnosis',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: params.temperature ?? 0.2,
          max_tokens: params.maxTokens ?? 3000,
          ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
          usage: { include: true },
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body) throw new OpenRouterError(`OpenRouter responded ${res.status}${body && (body as { error?: { message?: string } }).error?.message ? ': ' + (body as { error?: { message?: string } }).error!.message : ''}`, res.status, body);
      if ((body as { error?: unknown }).error) throw new OpenRouterError(String(((body as { error?: { message?: string } }).error?.message) ?? 'OpenRouter error'), res.status, body);
      const choice = (body.choices as { message?: { content?: unknown } }[] | undefined)?.[0];
      const content = choice?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('') : '';
      if (!text) throw new OpenRouterError('OpenRouter returned no content', res.status, body);
      const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      return {
        text,
        model: typeof body.model === 'string' ? body.model : model,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        costUsd: typeof usage.cost === 'number' ? usage.cost : null,
        durationMs: Date.now() - started,
        raw: body,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fallback pricing (USD per token) when OpenRouter does not include usage.cost. */
const PRICING: Record<string, { in: number; out: number }> = {
  'google/gemini-3.1-flash-lite': { in: 0.25e-6, out: 1.5e-6 },
  'google/gemini-2.5-flash-lite': { in: 0.10e-6, out: 0.40e-6 },
  'google/gemini-2.5-flash': { in: 0.30e-6, out: 2.5e-6 },
};
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  const p = key ? PRICING[key]! : { in: 0.5e-6, out: 2e-6 };
  return promptTokens * p.in + completionTokens * p.out;
}
