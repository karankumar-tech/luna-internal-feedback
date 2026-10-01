/**
 * One-time clean-up for benchmark sessions imported before sessions could be merged: joins every
 * pair that looks like one session recorded with different clocks (different devices, starting
 * within 20 minutes of each other, similar length). Needs SUPABASE_DB_URL, i.e. the server's .env.
 *
 *   npm run benchmarks:merge-nearby              lists the pairs, changes nothing
 *   npm run benchmarks:merge-nearby -- --apply   merges them
 *
 * The later session's recordings move into the earlier one and the later reference stops existing.
 * To undo a merge, remove the device from the session and import the export again.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { BenchmarksRepo } from '../src/modules/benchmarks/benchmarks.repo.js';
import { BenchmarksService } from '../src/modules/benchmarks/benchmarks.service.js';

const apply = process.argv.includes('--apply');
const db = createPool(loadConfig());
const service = new BenchmarksService(new BenchmarksRepo(db));

try {
  const pairs = await service.mergeLikelySame(apply);
  if (!pairs.length) console.log('No sessions look like the same session recorded twice.');
  for (const p of pairs) {
    const m = Math.round(Math.abs(p.starts_after_s) / 60);
    console.log(`${apply ? 'merged ' : 'would merge '} ${p.from} (${p.devices.join(', ')}) into ${p.into}: starts ${m} min ${p.starts_after_s < 0 ? 'earlier' : 'later'}`);
  }
  if (pairs.length && !apply) console.log('\nNothing was changed. Run again with --apply to merge these.');
} finally {
  await db.end();
}
