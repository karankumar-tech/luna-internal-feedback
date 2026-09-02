// Applies supabase/migrations/*.sql in filename order, once each.
// Tracks applied files in luna_feedback.schema_migrations so it is safe to re-run.
// Usage: npm run db:migrate            (uses SUPABASE_DB_URL from .env)
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const dir = path.resolve('supabase/migrations');
const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('SUPABASE_DB_URL is not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

await client.query('create schema if not exists luna_feedback');
await client.query(`create table if not exists luna_feedback.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)`);
await client.query('alter table luna_feedback.schema_migrations enable row level security');

const applied = new Set((await client.query('select name from luna_feedback.schema_migrations')).rows.map(r => r.name));
const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();

let ran = 0;
for (const file of files) {
  if (applied.has(file)) { console.log(`skip    ${file}`); continue; }
  const sql = await readFile(path.join(dir, file), 'utf8');
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into luna_feedback.schema_migrations (name) values ($1)', [file]);
    await client.query('commit');
    console.log(`applied ${file}`);
    ran++;
  } catch (err) {
    await client.query('rollback');
    console.error(`FAILED  ${file}\n${err.message}`);
    await client.end();
    process.exit(1);
  }
}
console.log(ran ? `${ran} migration(s) applied` : 'database already up to date');
await client.end();
