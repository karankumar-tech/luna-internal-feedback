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
