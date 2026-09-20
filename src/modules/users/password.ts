import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * scrypt parameters. N=2^15 costs ~60 ms and ~32 MB per hash here, which is the right
 * order for an internal tool: slow enough to make guessing expensive, fast enough that a
 * sign-in does not feel stuck. They are stored in the hash, so raising them later leaves
 * existing passwords verifiable under the parameters they were made with.
 */
const PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;
const KEYLEN = 32;
const SALT_BYTES = 16;
// scrypt needs roughly 128 * N * r bytes; Node's default 32 MB cap is exactly at the edge.
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time check. Returns false for anything malformed rather than throwing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts as [string, string, string, string, string, string];
  const N = Number(nRaw), r = Number(rRaw), p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    expected = Buffer.from(keyRaw, 'base64');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  try {
    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Rules kept deliberately mild: length does the work, character classes mostly annoy people. */
export const PASSWORD_RULES = [
  `at least ${PASSWORD_MIN_LENGTH} characters`,
  'at least one letter and one digit',
  'not your email address, and not an obvious word like "password"',
  'different from your last 5 passwords',
] as const;

const OBVIOUS = [
  'password', 'passw0rd', 'qwerty', 'welcome', 'letmein', 'admin123', 'changeme',
  '12345678', '123456789', '1234567890', 'iloveyou', 'abc123', 'luna1234', 'lunaring',
];

export interface PasswordProblem { path: string; message: string }

/** Validates a proposed password. Returns [] when it is acceptable. */
export function checkPasswordStrength(password: string, context: { email?: string; name?: string | null } = {}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const value = password.normalize('NFKC');

  if (value.length < PASSWORD_MIN_LENGTH) problems.push({ path: 'password', message: `must be at least ${PASSWORD_MIN_LENGTH} characters` });
  if (value.length > PASSWORD_MAX_LENGTH) problems.push({ path: 'password', message: `must be at most ${PASSWORD_MAX_LENGTH} characters` });
  if (value.trim() !== value) problems.push({ path: 'password', message: 'must not start or end with a space' });
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) problems.push({ path: 'password', message: 'must contain at least one letter and one digit' });

  const lower = value.toLowerCase();
  if (OBVIOUS.some((w) => lower.includes(w))) problems.push({ path: 'password', message: 'is too easy to guess; avoid common words like "password" or "qwerty"' });

  // The local part of the email, and any name word of 4+ characters.
  const local = (context.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) problems.push({ path: 'password', message: 'must not contain your email address' });
  for (const word of (context.name ?? '').toLowerCase().split(/\s+/)) {
    if (word.length >= 4 && lower.includes(word)) { problems.push({ path: 'password', message: 'must not contain your name' }); break; }
  }

  if (/^(.)\1+$/.test(value)) problems.push({ path: 'password', message: 'must not be a single repeated character' });
  return problems;
}

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A password an admin can read out or paste into chat.
 * Avoids look-alike characters (l/1/I, O/0) and always satisfies the strength rules.
 */
export function generatePassword(length = 14): string {
  const size = Math.max(PASSWORD_MIN_LENGTH, Math.min(length, 32));
  for (;;) {
    // Rejection sampling keeps every character equally likely.
    const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
    let out = '';
    while (out.length < size) {
      for (const byte of randomBytes(size * 2)) {
        if (byte >= limit) continue;
        out += ALPHABET[byte % ALPHABET.length];
        if (out.length === size) break;
      }
    }
    if (checkPasswordStrength(out).length === 0) return out;
  }
}
