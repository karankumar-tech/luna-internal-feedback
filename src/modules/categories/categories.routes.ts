import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { zodIssues } from '../../schema/buildValidator.js';
import type { CategoriesRepo } from './categories.repo.js';

const Slug = z.string().trim().regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase slug like wrong_peak_score').max(64);

const CreateCategory = z.object({
  key: Slug,
  label: z.string().trim().min(1).max(120),
  sort_order: z.number().int().default(0),
}).strict();

const PatchCategory = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
}).strict();

const PatchFeature = PatchCategory;

function parseOr422<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw AppError.validation(zodIssues(r.error));
  return r.data;
}

export function registerAdminRoutes(app: FastifyInstance, deps: { categories: CategoriesRepo }) {
  const { categories } = deps;

  app.get('/v1/admin/features', async () => ({ items: await categories.allFeatures() }));

  app.patch<{ Params: { feature: string } }>('/v1/admin/features/:feature', async (req) => {
    const patch = parseOr422(PatchFeature, req.body);
    const row = await categories.updateFeature(req.params.feature, patch);
    if (!row) throw AppError.notFound(`Unknown feature "${req.params.feature}"`);
    return row;
  });

  app.get<{ Params: { feature: string } }>('/v1/admin/features/:feature/issue-categories', async (req) => {
    if (!(await categories.feature(req.params.feature))) throw AppError.notFound(`Unknown feature "${req.params.feature}"`);
    return { items: await categories.listAll(req.params.feature) };
  });

  app.post<{ Params: { feature: string } }>('/v1/admin/features/:feature/issue-categories', async (req, reply) => {
    if (!(await categories.feature(req.params.feature))) throw AppError.notFound(`Unknown feature "${req.params.feature}"`);
    const input = parseOr422(CreateCategory, req.body) as { key: string; label: string; sort_order: number };
    try {
      const row = await categories.create({ feature_key: req.params.feature, ...input });
      return reply.code(201).send(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw AppError.conflict(`Category "${input.key}" already exists for ${req.params.feature}`);
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/issue-categories/:id', async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw AppError.notFound('Category not found');
    const patch = parseOr422(PatchCategory, req.body);
    const row = await categories.update(req.params.id, patch);
    if (!row) throw AppError.notFound('Category not found');
    return row;
  });
}
