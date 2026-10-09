import { describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../../src/modules/diagnosis/ai/openrouter.js';

const reply = (usage: Record<string, number>, model = 'google/gemini-3.1-flash-lite') =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: 'ok' } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('OpenRouterClient usage sink', () => {
  it('reports the model and token counts of every successful call', async () => {
    const seen: { model: string; promptTokens: number; completionTokens: number }[] = [];
    const client = new OpenRouterClient({ apiKey: 'k', model: 'google/gemini-3.1-flash-lite', fetchImpl: async () => reply({ prompt_tokens: 120, completion_tokens: 30 }) });
    client.setUsageSink(({ model, promptTokens, completionTokens }) => { seen.push({ model, promptTokens, completionTokens }); });
    await client.complete([{ role: 'user', content: 'hi' }]);
    await client.completeJson([{ role: 'user', content: 'hi' }], {});
    expect(seen).toEqual([
      { model: 'google/gemini-3.1-flash-lite', promptTokens: 120, completionTokens: 30 },
      { model: 'google/gemini-3.1-flash-lite', promptTokens: 120, completionTokens: 30 },
    ]);
  });

  it('uses the model the response names, counts missing usage as zero, and survives a throwing sink', async () => {
    const seen: string[] = [];
    const client = new OpenRouterClient({ apiKey: 'k', model: 'x', fetchImpl: async () => reply({}, 'google/gemini-2.5-flash') });
    client.setUsageSink((u) => { seen.push(`${u.model}:${u.promptTokens}/${u.completionTokens}`); throw new Error('sink down'); });
    const r = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(r.text).toBe('ok');
    expect(seen).toEqual(['google/gemini-2.5-flash:0/0']);
  });

  it('is not told about failed calls', async () => {
    let calls = 0;
    const client = new OpenRouterClient({ apiKey: 'k', model: 'x', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 }) });
    client.setUsageSink(() => { calls += 1; });
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
