import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { OpenRouterCatalog } from '../diagnosis/ai/models.js';
import type { AiModels } from './ai-models.js';

/** An OpenRouter model id ("google/gemini-2.5-flash"), or null for the default. */
const ModelId = z.string().trim().min(1, 'pick a model').max(200, 'must be at most 200 characters').nullable();

export function registerSettingsRoutes(app: FastifyInstance, deps: { aiModels: AiModels; catalog: OpenRouterCatalog }) {
  /** Which models the AI uses now, the defaults, who changed them last, and recent token use. */
  app.get('/v1/admin/ai-models', async () => deps.aiModels.state());

  /** Every model OpenRouter offers that answers in text, with prices and what it can do. */
  app.get('/v1/admin/ai-models/available', async () => {
    const { models, fetched_at } = await deps.catalog.list();
    return { items: models, count: models.length, fetched_at };
  });

  /** Picks the diagnosis model, the chat model or both. A field left out stays; null goes back to the default. */
  app.patch('/v1/admin/ai-models', { onRequest: requirePermission('manage_ai_models') }, async (req) => {
    const parsed = z.object({ diagnosis: ModelId.optional(), chat: ModelId.optional() }).strict()
      .refine((b) => b.diagnosis !== undefined || b.chat !== undefined, { message: 'send diagnosis, chat or both' })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return deps.aiModels.change(parsed.data, actorOf(req));
  });
}
