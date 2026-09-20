import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { createPool, type Db } from './db/pool.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerFeedbackRoutes } from './modules/feedback/feedback.routes.js';
import { registerAdminRoutes } from './modules/categories/categories.routes.js';
import { registerPageRoutes } from './modules/pages/pages.routes.js';
import { sessionSecretFrom } from './plugins/dashboardSession.js';
import { DiagnosisRepo } from './modules/diagnosis/diagnosis.repo.js';
import { DiagnosisService } from './modules/diagnosis/diagnosis.service.js';
import { registerDiagnosisRoutes } from './modules/diagnosis/diagnosis.routes.js';
import { LogsClient } from './modules/diagnosis/logs/client.js';
import { OpenRouterClient } from './modules/diagnosis/ai/openrouter.js';
import { ImageKitClient } from './modules/uploads/imagekit.js';
import { CategoriesRepo } from './modules/categories/categories.repo.js';
import { FeedbackRepo } from './modules/feedback/feedback.repo.js';
import { FeedbackService } from './modules/feedback/feedback.service.js';
import { KindsRepo } from './modules/kinds/kinds.repo.js';
import { KindsService } from './modules/kinds/kinds.service.js';
import { registerKindRoutes } from './modules/kinds/kinds.routes.js';
import { JiraClient } from './modules/jira/jira.client.js';
import { JiraService } from './modules/jira/jira.service.js';
import { registerJiraRoutes } from './modules/jira/jira.routes.js';
import { ChatRepo } from './modules/chat/chat.repo.js';
import { ChatService } from './modules/chat/chat.service.js';
import { registerChatRoutes } from './modules/chat/chat.routes.js';
import { AnalyticsRepo } from './modules/analytics/analytics.repo.js';
import { registerAnalyticsRoutes } from './modules/analytics/analytics.routes.js';

export interface BuildOptions {
  config?: Config;
  db?: Db;
  logger?: boolean | object;
  /** Test seams for the diagnosis pipeline. */
  diagnosis?: { logs?: LogsClient | null; ai?: OpenRouterClient | null; fetchImpl?: typeof fetch; now?: () => Date };
  /** Test seam: replaces the ImageKit client built from config. */
  imagekit?: ImageKitClient | null;
  /** Test seam: replaces the Jira client built from config. */
  jira?: JiraClient | null;
  /** Fastify factory. server.ts passes the real import so Vercel's entrypoint detector sees `fastify` imported there. */
  fastify?: typeof Fastify;
}

export interface App extends FastifyInstance {
  db: Db;
  config: Config;
  diagnosis: DiagnosisService;
  jira: JiraService;
}

export function buildApp(opts: BuildOptions = {}): App {
  const config = opts.config ?? loadConfig();
  const db = opts.db ?? createPool(config);

  // Pretty logs only on an interactive terminal. Serverless bundles (Vercel) cannot spawn
  // the pino-pretty worker transport, so anything non-TTY gets plain JSON logs.
  const pretty = config.NODE_ENV === 'development' && Boolean(process.stdout.isTTY) && !process.env.VERCEL;
  const logger =
    opts.logger ??
    (pretty
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

  // Tolerate an empty body with content-type: application/json (e.g. POST /…/diagnose with no payload).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try { done(null, JSON.parse(text)); }
    catch (err) { const e = err instanceof Error ? err : new Error('Invalid JSON'); (e as { statusCode?: number }).statusCode = 400; done(e, undefined); }
  });

  const categories = new CategoriesRepo(db, config.CATEGORY_CACHE_TTL_MS);
  const feedbackRepo = new FeedbackRepo(db);
  const service = new FeedbackService(feedbackRepo, categories, config.APP_TIMEZONE);
  const kindsRepo = new KindsRepo(db);
  const kinds = new KindsService(kindsRepo);

  const diagnosisRepo = new DiagnosisRepo(db);
  const logsClient = opts.diagnosis && 'logs' in opts.diagnosis ? opts.diagnosis.logs ?? null
    : config.LUNA_LOGS_APIKEY ? new LogsClient({ baseUrl: config.LUNA_LOGS_BASE_URL, apiKey: config.LUNA_LOGS_APIKEY }) : null;
  const aiClient = opts.diagnosis && 'ai' in opts.diagnosis ? opts.diagnosis.ai ?? null
    : config.OPEN_ROUTER_KEY ? new OpenRouterClient({ apiKey: config.OPEN_ROUTER_KEY, model: config.OPENROUTER_MODEL }) : null;
  const diagnosis = new DiagnosisService({
    repo: diagnosisRepo, feedback: feedbackRepo, categories, logs: logsClient, ai: aiClient, kinds,
    config: { model: config.OPENROUTER_MODEL, auto: config.DIAGNOSIS_AUTO, dailyBudgetUsd: config.DIAGNOSIS_DAILY_BUDGET_USD, timeZone: config.APP_TIMEZONE, maxAttempts: 6, syncHourIst: config.DIAGNOSIS_SYNC_HOUR_IST },
    log: app.log, fetchImpl: opts.diagnosis?.fetchImpl, now: opts.diagnosis?.now,
  });
  app.diagnosis = diagnosis;
  service.setDiagnosisHook({ onNegativeSubmission: (id, log) => diagnosis.enqueueAndRun(id, log) });
  if (!diagnosis.enabled) app.log.warn('AI diagnosis disabled: set LUNA_LOGS_APIKEY and OPEN_ROUTER_KEY to enable');

  const chat = new ChatService({
    repo: new ChatRepo(db), feedback: feedbackRepo, diagnoses: diagnosisRepo, categories, ai: aiClient,
    config: { maxMessages: config.DIAGNOSIS_CHAT_MAX_MESSAGES, model: config.DIAGNOSIS_CHAT_MODEL ?? null, dailyBudgetUsd: config.DIAGNOSIS_DAILY_BUDGET_USD },
    log: app.log,
  });

  // Jira stays optional: with the four vars unset the endpoints answer with exactly what to add.
  const jiraClient = opts.jira !== undefined ? opts.jira
    : config.JIRA_BASE_URL && config.JIRA_EMAIL && config.JIRA_API_TOKEN && config.JIRA_PROJECT_KEY
      ? new JiraClient({
          baseUrl: config.JIRA_BASE_URL, email: config.JIRA_EMAIL, apiToken: config.JIRA_API_TOKEN,
          projectKey: config.JIRA_PROJECT_KEY, issueType: config.JIRA_ISSUE_TYPE,
          labels: config.JIRA_LABELS.split(',').map((s) => s.trim()).filter(Boolean),
        })
      : null;
  const jira = new JiraService({
    client: jiraClient, feedback: feedbackRepo, diagnoses: diagnosisRepo, kinds: kindsRepo, categories,
    publicBaseUrl: config.PUBLIC_BASE_URL, log: app.log,
  });
  app.jira = jira;
  if (!jira.enabled) app.log.info({ missing: jira.status().missing_env }, 'Jira integration idle: set these to enable ticket creation');

  registerErrorHandler(app);
  const sessionSecret = sessionSecretFrom(config.DASHBOARD_KEY);
  registerAuth(app, { app: config.APP_API_KEY, admin: config.ADMIN_API_KEY, sessionSecret, cronSecret: config.CRON_SECRET });
  registerHealthRoutes(app, { db });
  const imagekit = opts.imagekit !== undefined ? opts.imagekit : config.IMAGEKIT_PUB_KEY && config.IMAGEKIT_PRI_KEY
    ? new ImageKitClient({ publicKey: config.IMAGEKIT_PUB_KEY, privateKey: config.IMAGEKIT_PRI_KEY, urlEndpoint: config.IMAGEKIT_URL_ENDPOINT, folder: config.IMAGEKIT_FOLDER })
    : null;
  if (imagekit) service.setScreenshotSupport({ isOurUrl: (u) => imagekit.isOurUrl(u), maxCount: config.SCREENSHOT_MAX_COUNT, deleteFile: (id) => imagekit.deleteFile(id) });
  else app.log.warn('Screenshot uploads disabled: set IMAGEKIT_PUB_KEY and IMAGEKIT_PRI_KEY to enable');
  registerFeedbackRoutes(app, {
    service, categories, timeZone: config.APP_TIMEZONE,
    uploads: imagekit ? { publicKey: imagekit.publicKey, urlEndpoint: imagekit.urlEndpoint, folder: imagekit.folder, maxBytes: config.SCREENSHOT_MAX_BYTES, maxCount: config.SCREENSHOT_MAX_COUNT, authParams: () => imagekit.authParams() } : null,
  });
  registerPageRoutes(app, { dashboardKey: config.DASHBOARD_KEY, sessionSecret, sessionDays: config.DASHBOARD_SESSION_DAYS });
  registerAdminRoutes(app, { categories });
  registerDiagnosisRoutes(app, { service: diagnosis, repo: diagnosisRepo });
  registerKindRoutes(app, { service: kinds, timeZone: config.APP_TIMEZONE });
  registerJiraRoutes(app, { service: jira });
  registerChatRoutes(app, { service: chat });
  registerAnalyticsRoutes(app, { repo: new AnalyticsRepo(db), timeZone: config.APP_TIMEZONE });

  app.addHook('onClose', async () => {
    if (!opts.db) await db.end();
  });

  return app;
}
