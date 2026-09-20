import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  SUPABASE_DB_URL: z.string().url().describe('Postgres connection string from Supabase'),
  APP_API_KEY: z.string().min(16, 'APP_API_KEY must be at least 16 chars'),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 chars'),
  DASHBOARD_KEY: z.string().min(16, 'DASHBOARD_KEY must be at least 16 chars'),
  DASHBOARD_SESSION_DAYS: z.coerce.number().int().positive().max(365).default(30),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  /** Used to build links that leave the app (Jira ticket bodies). */
  PUBLIC_BASE_URL: z.string().url().default('https://luna-feedback.buildsage.tech'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  // --- AI diagnosis (optional: when either key is missing, diagnosis is disabled and submissions still work) ---
  LUNA_LOGS_APIKEY: z.string().min(8).optional(),
  LUNA_LOGS_BASE_URL: z.string().url().default('https://stage-app.gonoise.com'),
  OPEN_ROUTER_KEY: z.string().min(8).optional(),
  OPENROUTER_MODEL: z.string().default('google/gemini-3.1-flash-lite'),
  DIAGNOSIS_AUTO: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  DIAGNOSIS_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(2),
  DIAGNOSIS_SYNC_HOUR_IST: z.coerce.number().int().min(0).max(23).default(20),
  CRON_SECRET: z.string().min(16).optional(),
  // --- Screenshots on ImageKit (optional: when keys are missing, screenshots are refused with a clear error) ---
  IMAGEKIT_PUB_KEY: z.string().min(8).optional(),
  IMAGEKIT_PRI_KEY: z.string().min(8).optional(),
  IMAGEKIT_URL_ENDPOINT: z.string().url().default('https://ik.imagekit.io/noisekaranikid'),
  IMAGEKIT_FOLDER: z.string().default('/luna-feedback-screenshots'),
  SCREENSHOT_MAX_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  SCREENSHOT_MAX_COUNT: z.coerce.number().int().min(1).max(10).default(5),
  // --- Per-ticket follow-up chat with the model (optional: needs OPEN_ROUTER_KEY) ---
  DIAGNOSIS_CHAT_MAX_MESSAGES: z.coerce.number().int().min(1).max(50).default(10),
  DIAGNOSIS_CHAT_MODEL: z.string().optional(),
  // --- Jira (optional: when any of the four is missing, the Jira buttons explain what to add) ---
  JIRA_BASE_URL: z.string().url().optional().describe('https://your-team.atlassian.net'),
  JIRA_EMAIL: z.string().email().optional().describe('Atlassian account the API token belongs to'),
  JIRA_API_TOKEN: z.string().min(8).optional(),
  JIRA_PROJECT_KEY: z.string().min(1).max(20).optional().describe('e.g. LUNA'),
  JIRA_ISSUE_TYPE: z.string().default('Bug'),
  JIRA_LABELS: z.string().default('luna-feedback').describe('Comma-separated labels added to every created issue'),
  // --- Dashboard accounts (phase 2) ---
  /** Days before a password must be changed. 0 disables expiry. */
  PASSWORD_MAX_AGE_DAYS: z.coerce.number().int().nonnegative().default(30),
  /** How many previous passwords may not be reused. */
  PASSWORD_HISTORY_DEPTH: z.coerce.number().int().min(0).max(10).default(5),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(8),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  CATEGORY_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(30_000),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

/** Parses process.env once; throws a readable error listing every missing/invalid var. */
export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  if (Object.keys(overrides).length === 0) cached = parsed.data;
  return parsed.data;
}
