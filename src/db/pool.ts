import pg from 'pg';
import type { Config } from '../config.js';

export type Db = pg.Pool;

/**
 * Direct Postgres connection to the Supabase project.
 * Every query uses fully-qualified `luna_feedback.*` names, so no search_path juggling.
 * On serverless keep DB_POOL_MAX small (1–2) and prefer the transaction pooler (port 6543).
 */
export function createPool(config: Config): Db {
  const pool = new pg.Pool({
    connectionString: config.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'luna-feedback-api',
  });
  pool.on('error', (err) => {
    // Idle client errors (e.g. pooler dropped the connection). Pool replaces the client.
    console.error('[pg] idle client error', err.message);
  });
  return pool;
}
