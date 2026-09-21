/**
 * Creates an admin account, or promotes an existing account to admin, and issues a one-time
 * password for it.
 *
 * The way back in when nobody can reach /dashboard/users: it talks to the database directly,
 * so it works regardless of what state the accounts are in. Needs SUPABASE_DB_URL, i.e. the
 * same .env the server uses.
 *
 *   npm run users:grant-admin -- someone@nexxbase.com "Their Name"
 *
 * The password it prints is shown once and is not stored in the clear. The account is flagged
 * must_change, so whoever receives it has to replace it at first sign-in.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { UsersRepo } from '../src/modules/users/users.repo.js';
import { generatePassword, hashPassword } from '../src/modules/users/password.js';

const [emailArg, nameArg] = process.argv.slice(2);

if (!emailArg || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailArg)) {
  console.error('Usage: npm run users:grant-admin -- <email> [name]');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const config = loadConfig();
const db = createPool(config);
const repo = new UsersRepo(db);

try {
  const password = generatePassword();
  const hash = await hashPassword(password);
  const existing = await repo.byEmail(email);

  if (existing) {
    await repo.update(existing.id, { role: 'admin', is_disabled: false });
    await repo.setPassword(existing.id, hash, true);
    await repo.logEvent({ actor: 'grant-admin script', target: email, action: 'user_updated', detail: 'role=admin, password reset' });
    console.log(`\nPromoted ${email} to admin and issued a new password.`);
  } else {
    const created = await repo.create({
      email,
      name: nameArg?.trim() || null,
      role: 'admin',
      passwordHash: hash,
      mustChange: true,
      createdBy: 'grant-admin script',
    });
    await repo.logEvent({ actor: 'grant-admin script', target: email, action: 'user_created', detail: 'role=admin' });
    console.log(`\nCreated admin ${created.email}.`);
  }

  console.log(`\n  email     ${email}`);
  console.log(`  password  ${password}`);
  console.log('\nSign in at /dashboard. You will be asked to choose your own password immediately;');
  console.log('this one stops working as soon as you do.\n');
} finally {
  await db.end();
}
