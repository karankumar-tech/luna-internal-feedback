import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { createPool, type Db } from './db/pool.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerFeedbackRoutes, type ScreenshotUploads } from './modules/feedback/feedback.routes.js';
import { registerAdminRoutes } from './modules/categories/categories.routes.js';
import { registerPageRoutes } from './modules/pages/pages.routes.js';
import { LoginThrottle } from './modules/pages/login-throttle.js';
import { sessionSecretFrom } from './plugins/dashboardSession.js';
import { DiagnosisRepo } from './modules/diagnosis/diagnosis.repo.js';
import { DiagnosisService } from './modules/diagnosis/diagnosis.service.js';
import { registerDiagnosisRoutes } from './modules/diagnosis/diagnosis.routes.js';
import { LogsClient } from './modules/diagnosis/logs/client.js';
import { OpenRouterClient } from './modules/diagnosis/ai/openrouter.js';
import { OpenRouterCatalog } from './modules/diagnosis/ai/models.js';
import { ImageKitClient } from './modules/uploads/imagekit.js';
import { S3ScreenshotStore } from './modules/uploads/s3.js';
import { ScreenshotStorage } from './modules/uploads/screenshots.js';
import { registerUploadRoutes } from './modules/uploads/uploads.routes.js';
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
import { ModelUsageRepo } from './modules/analytics/model-usage.repo.js';
import { UsersRepo } from './modules/users/users.repo.js';
import { UsersService } from './modules/users/users.service.js';
import { registerUserRoutes } from './modules/users/users.routes.js';
import { registerCxRoutes } from './modules/cx/cx.routes.js';
import { BetaUsersRepo } from './modules/beta/beta-users.repo.js';
import { registerBetaRoutes } from './modules/beta/beta.routes.js';
import { AttentionRepo } from './modules/attention/attention.repo.js';
import { AttentionService } from './modules/attention/attention.service.js';
import { registerAttentionRoutes } from './modules/attention/attention.routes.js';
import { HomeRepo } from './modules/home/home.repo.js';
import { HomeService } from './modules/home/home.service.js';
import { registerHomeRoutes } from './modules/home/home.routes.js';
import { SimilarRepo } from './modules/similar/similar.repo.js';
import { SimilarService } from './modules/similar/similar.service.js';
import { registerSimilarRoutes } from './modules/similar/similar.routes.js';
import { ActivityRepo } from './modules/activity/activity.repo.js';
import { registerActivityRoutes } from './modules/activity/activity.routes.js';
import { BenchmarksRepo } from './modules/benchmarks/benchmarks.repo.js';
import { BenchmarksService } from './modules/benchmarks/benchmarks.service.js';
import { registerBenchmarkRoutes } from './modules/benchmarks/benchmarks.routes.js';
import { SprintsRepo } from './modules/sprints/sprints.repo.js';
import { SprintsService } from './modules/sprints/sprints.service.js';
import { registerSprintRoutes } from './modules/sprints/sprints.routes.js';
import { SettingsRepo } from './modules/settings/settings.repo.js';
import { AiModels } from './modules/settings/ai-models.js';
import { registerSettingsRoutes } from './modules/settings/settings.routes.js';
import { runInBackground } from './modules/diagnosis/background.js';
import type { Environment } from './schema/registry.js';

export interface BuildOptions {
  config?: Config;
  db?: Db;
  logger?: boolean | object;
  /**
   * Test seams for the diagnosis pipeline. `logs` alone serves every environment; `logsByEnv`
   * overrides it per environment (null = no logging host for that environment).
   */
  diagnosis?: { logs?: LogsClient | null; logsByEnv?: Partial<Record<Environment, LogsClient | null>>; ai?: OpenRouterClient | null; models?: OpenRouterCatalog; fetchImpl?: typeof fetch; now?: () => Date };
  /** Test seam: replaces the ImageKit client built from config. */
  imagekit?: ImageKitClient | null;
  /** Test seam: replaces the S3 screenshot store built from config. */
  s3?: S3ScreenshotStore | null;
  /** Test seam: replaces the Jira client built from config. */
  jira?: JiraClient | null;
  /** Test seam: the clock sprint timing (days left, overdue) is measured against. */
  now?: () => Date;
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
  // Every change to a report, and every note, lands in its history.
  const activity = new ActivityRepo(db);
  service.setActivity(activity);
  kinds.setActivity(activity);
  // Sprints: a report can be filed into, or moved to, the current or next sprint.
  const sprints = new SprintsService(new SprintsRepo(db, config.APP_TIMEZONE), config.APP_TIMEZONE, opts.now);
  service.setSprintHook({ resolve: (target, by) => sprints.resolve(target, by) });
  // Beta users: the released app asks on every launch, so the list is kept in memory.
  const betaUsers = new BetaUsersRepo(db, config.BETA_USERS_CACHE_TTL_MS, (err) => app.log.error({ err }, 'beta list reload failed; answering from the copy held'));
  service.setBetaCheck((id) => betaUsers.has(id));

  const diagnosisRepo = new DiagnosisRepo(db);
  // Stage and production logs live on different hosts behind the same key. UAT has none until its
  // host is configured, so its reports are never looked up.
  const logsAt = (baseUrl: string | undefined) => (config.LUNA_LOGS_APIKEY && baseUrl ? new LogsClient({ baseUrl, apiKey: config.LUNA_LOGS_APIKEY }) : null);
  const seamed = opts.diagnosis && 'logs' in opts.diagnosis;
  const logsClient = seamed ? opts.diagnosis!.logs ?? null : logsAt(config.LUNA_LOGS_BASE_URL_STAGE ?? config.LUNA_LOGS_BASE_URL);
  const logsByEnv = opts.diagnosis?.logsByEnv ?? (seamed ? undefined : {
    stage: logsClient,
    production: logsAt(config.LUNA_LOGS_BASE_URL_PRODUCTION),
    uat: logsAt(config.LUNA_LOGS_BASE_URL_UAT),
  });
  const aiClient = opts.diagnosis && 'ai' in opts.diagnosis ? opts.diagnosis.ai ?? null
    : config.OPEN_ROUTER_KEY ? new OpenRouterClient({ apiKey: config.OPEN_ROUTER_KEY, model: config.OPENROUTER_MODEL }) : null;
  // Every model call, whatever it was for, adds to the day's token count on the analytics page.
  const modelUsage = new ModelUsageRepo(db, config.APP_TIMEZONE);
  aiClient?.setUsageSink((u) => { modelUsage.record(u).catch((err) => app.log.warn({ err, model: u.model }, 'model usage not recorded')); });
  // Which models get called: OPENROUTER_MODEL and DIAGNOSIS_CHAT_MODEL unless an admin picked others in Settings.
  const catalog = opts.diagnosis?.models ?? new OpenRouterCatalog();
  const aiModels = new AiModels({
    settings: new SettingsRepo(db, undefined, (err) => app.log.error({ err }, 'settings reload failed; answering from the copy held')),
    catalog, enabled: aiClient !== null,
    defaults: { diagnosis: aiClient?.model ?? config.OPENROUTER_MODEL, chat: config.DIAGNOSIS_CHAT_MODEL ?? null },
    recentTokens: () => diagnosisRepo.recentTokens(30), log: app.log,
  });
  const diagnosis = new DiagnosisService({
    repo: diagnosisRepo, feedback: feedbackRepo, categories, logs: logsClient, logsByEnv, ai: aiClient, kinds, model: () => aiModels.diagnosis(),
    config: { auto: config.DIAGNOSIS_AUTO, dailyBudgetUsd: config.DIAGNOSIS_DAILY_BUDGET_USD, timeZone: config.APP_TIMEZONE, maxAttempts: 6, syncHourIst: config.DIAGNOSIS_SYNC_HOUR_IST },
    log: app.log, fetchImpl: opts.diagnosis?.fetchImpl, now: opts.diagnosis?.now,
  });
  app.diagnosis = diagnosis;
  service.setDiagnosisHook({ onNegativeSubmission: (id, log) => diagnosis.enqueueAndRun(id, log) });
  // A CX report arrives with only its ring serial; the logging service knows the rest.
  service.setDeviceHook({ onCxSubmission: (id, log) => runInBackground(() => diagnosis.fillDeviceFromLogs(id), log, `device ${id}`) });

  // Every new issue is matched against open problems and, when it clearly looks like one, gets a
  // "Looks like …" suggestion. The CX tool waits for it (it shows the answer); the app does not.
  const similar = new SimilarService({ repo: new SimilarRepo(db), feedback: feedbackRepo, kinds, categories, ai: aiClient, model: async () => (await aiModels.diagnosis()).id });
  service.setSimilarityHook({
    onNewIssue: async (id, log, wait) => {
      if (wait) await similar.suggestForNew(id);
      else await runInBackground(() => similar.suggestForNew(id), log, `suggest ${id}`);
    },
  });
  if (!diagnosis.enabled) app.log.warn('AI diagnosis disabled: set LUNA_LOGS_APIKEY and OPEN_ROUTER_KEY to enable');

  const chat = new ChatService({
    repo: new ChatRepo(db), feedback: feedbackRepo, diagnoses: diagnosisRepo, categories, ai: aiClient, model: () => aiModels.chat(),
    config: { maxMessages: config.DIAGNOSIS_CHAT_MAX_MESSAGES, dailyBudgetUsd: config.DIAGNOSIS_DAILY_BUDGET_USD },
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
    publicBaseUrl: config.PUBLIC_BASE_URL, log: app.log, activity,
  });
  app.jira = jira;
  if (!jira.enabled) app.log.info({ missing: jira.status().missing_env }, 'Jira integration idle: set these to enable ticket creation');

  registerErrorHandler(app);
  const sessionSecret = sessionSecretFrom(config.DASHBOARD_KEY);

  const usersRepo = new UsersRepo(db);
  service.setAccountLookup((emails, ids) => usersRepo.activeAccounts(emails, ids));
  const users = new UsersService(usersRepo, {
    maxAgeDays: config.PASSWORD_MAX_AGE_DAYS,
    historyDepth: config.PASSWORD_HISTORY_DEPTH,
    maxFailedAttempts: config.LOGIN_MAX_ATTEMPTS,
    lockMinutes: config.LOGIN_LOCK_MINUTES,
    superAdminEmail: config.SUPERADMIN_EMAIL ?? null,
  });

  registerAuth(app, { app: config.APP_API_KEY, admin: config.ADMIN_API_KEY, cx: config.CX_API_KEY, beta: config.BETA_API_KEY, sessionSecret, cronSecret: config.CRON_SECRET, keyLogin: config.DASHBOARD_KEY_LOGIN }, {
    sessionFor: (id) => users.sessionFor(id),
    anyAdminExists: () => users.anyAdminExists(),
    superAdminEmail: () => users.superAdminEmail,
  });
  registerHealthRoutes(app, { db });
  const imagekit = opts.imagekit !== undefined ? opts.imagekit : config.IMAGEKIT_PUB_KEY && config.IMAGEKIT_PRI_KEY
    ? new ImageKitClient({ publicKey: config.IMAGEKIT_PUB_KEY, privateKey: config.IMAGEKIT_PRI_KEY, urlEndpoint: config.IMAGEKIT_URL_ENDPOINT, folder: config.IMAGEKIT_FOLDER })
    : null;
  const s3 = opts.s3 !== undefined ? opts.s3 : config.SCREENSHOT_S3_BUCKET
    ? new S3ScreenshotStore({ bucket: config.SCREENSHOT_S3_BUCKET, region: config.SCREENSHOT_S3_REGION, publicBaseUrl: config.PUBLIC_BASE_URL })
    : null;
  // New screenshots go to S3; ones already on ImageKit keep their links and are deleted there.
  const storage = new ScreenshotStorage(imagekit, s3);
  const screenshotSupport = storage.enabled ? { isOurUrl: (u: string) => storage.isOurUrl(u), deleteFile: (id: string) => storage.deleteFile(id) } : null;
  if (screenshotSupport) service.setScreenshotSupport({ ...screenshotSupport, maxCount: config.SCREENSHOT_MAX_COUNT });
  if (screenshotSupport) sprints.setScreenshotCleanup(screenshotSupport.deleteFile);
  else app.log.warn('Screenshot uploads disabled: set SCREENSHOT_S3_BUCKET (or IMAGEKIT_PUB_KEY and IMAGEKIT_PRI_KEY) to enable');
  const screenshotUploads: ScreenshotUploads | null = storage.enabled ? {
    maxBytes: config.SCREENSHOT_MAX_BYTES, maxCount: config.SCREENSHOT_MAX_COUNT, s3,
    imagekit: imagekit ? { publicKey: imagekit.publicKey, urlEndpoint: imagekit.urlEndpoint, folder: imagekit.folder, authParams: () => imagekit.authParams() } : null,
  } : null;
  registerUploadRoutes(app, { uploads: screenshotUploads });
  registerFeedbackRoutes(app, {
    service, categories, timeZone: config.APP_TIMEZONE, kindsFor: (ids) => kindsRepo.forSubmissions(ids),
    isAssignable: async (email) => (await users.assignable()).some((u) => u.email === email),
    testerNames: (emails) => usersRepo.namesFor(emails),
    betaNames: (ids) => betaUsers.namesFor(ids),
    uploads: screenshotUploads,
  });
  registerPageRoutes(app, { dashboardKey: config.DASHBOARD_KEY, sessionSecret, sessionDays: config.DASHBOARD_SESSION_DAYS, keyLogin: config.DASHBOARD_KEY_LOGIN, users, throttle: new LoginThrottle(db) });
  registerUserRoutes(app, { service: users });
  registerAdminRoutes(app, { categories });
  registerDiagnosisRoutes(app, { service: diagnosis, repo: diagnosisRepo, activity });
  registerKindRoutes(app, { service: kinds, feedback: service, timeZone: config.APP_TIMEZONE, isAssignable: async (email) => (await users.assignable()).some((u) => u.email === email) });
  registerSimilarRoutes(app, { service: similar });
  registerActivityRoutes(app, { feedback: service, activity, kinds, assignable: () => users.assignable() });
  registerJiraRoutes(app, { service: jira });
  registerChatRoutes(app, { service: chat });
  registerSettingsRoutes(app, { aiModels, catalog });
  registerAnalyticsRoutes(app, {
    repo: new AnalyticsRepo(db), timeZone: config.APP_TIMEZONE, usage: modelUsage,
    models: async () => ({ current: (await aiModels.diagnosis()).id, chat: await aiModels.chat(), enabled: aiClient !== null }),
  });
  registerCxRoutes(app, { feedback: service, kinds, activity, publicBaseUrl: config.PUBLIC_BASE_URL });
  registerBetaRoutes(app, { beta: betaUsers, feedback: service, uploads: screenshotUploads });
  const attention = new AttentionService(new AttentionRepo(db), config.APP_TIMEZONE);
  registerAttentionRoutes(app, { service: attention, feedback: service });
  registerHomeRoutes(app, { service: new HomeService(new HomeRepo(db, config.APP_TIMEZONE), { categories, attention, timeZone: config.APP_TIMEZONE, currentSprint: () => sprints.currentSummary() }) });
  registerSprintRoutes(app, { service: sprints });

  const benchmarks = new BenchmarksService(new BenchmarksRepo(db));
  if (screenshotSupport) benchmarks.setScreenshotSupport(screenshotSupport);
  registerBenchmarkRoutes(app, {
    service: benchmarks,
    uploads: screenshotUploads,
    exports: { baseUrl: config.PUBLIC_BASE_URL, timeZone: config.APP_TIMEZONE },
  });

  app.addHook('onClose', async () => {
    if (!opts.db) await db.end();
  });

  return app;
}
