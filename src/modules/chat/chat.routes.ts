import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { ChatService } from './chat.service.js';

export function registerChatRoutes(app: FastifyInstance, deps: { service: ChatService }) {
  const { service } = deps;

  app.get<{ Params: { id: string } }>('/v1/feedback/:id/diagnosis/chat', async (req) => service.state(req.params.id));

  /** One follow-up question. Capped per ticket; the reply comes back with the updated state. */
  app.post<{ Params: { id: string } }>('/v1/admin/submissions/:id/diagnosis/chat', async (req) => {
    const parsed = z.object({ message: z.string().min(1).max(2000) }).strict().safeParse(req.body);
    if (!parsed.success) throw AppError.validation(zodIssues(parsed.error));
    return service.send(req.params.id, parsed.data.message, actorOf(req));
  });
}
