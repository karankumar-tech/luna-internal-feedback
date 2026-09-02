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
