import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { createPool, type Db } from './db/pool.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerFeedbackRoutes } from './modules/feedback/feedback.routes.js';
import { registerAdminRoutes } from './modules/categories/categories.routes.js';
import { CategoriesRepo } from './modules/categories/categories.repo.js';
import { FeedbackRepo } from './modules/feedback/feedback.repo.js';
import { FeedbackService } from './modules/feedback/feedback.service.js';

export interface BuildOptions {
  config?: Config;
  db?: Db;
  logger?: boolean | object;
  /** Fastify factory. server.ts passes the real import so Vercel's entrypoint detector sees `fastify` imported there. */
  fastify?: typeof Fastify;
}

export interface App extends FastifyInstance {
  db: Db;
  config: Config;
}

export function buildApp(opts: BuildOptions = {}): App {
  const config = opts.config ?? loadConfig();
  const db = opts.db ?? createPool(config);

  const logger =
    opts.logger ??
    (config.NODE_ENV === 'development'
      ? { level: config.LOG_LEVEL, transport: { target: 'pino-pretty', options: { colorize: true } } }
      : { level: config.LOG_LEVEL });

  const fastify = opts.fastify ?? Fastify;
  const app = fastify({
    logger,
    bodyLimit: 64 * 1024,
    trustProxy: true,
  }) as unknown as App;

  app.db = db;
  app.config = config;

  const categories = new CategoriesRepo(db, config.CATEGORY_CACHE_TTL_MS);
  const feedbackRepo = new FeedbackRepo(db);
  const service = new FeedbackService(feedbackRepo, categories, config.APP_TIMEZONE);

  registerErrorHandler(app);
  registerAuth(app, { app: config.APP_API_KEY, admin: config.ADMIN_API_KEY });
  registerHealthRoutes(app, { db });
  registerFeedbackRoutes(app, { service, categories });
  registerAdminRoutes(app, { categories });

  app.addHook('onClose', async () => {
    if (!opts.db) await db.end();
  });

  return app;
}
