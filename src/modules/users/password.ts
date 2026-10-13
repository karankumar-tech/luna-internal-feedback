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

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Rules kept deliberately few: most people could not get past the earlier ones (10 characters, a
 * letter and a digit, no part of their name or email). Length does the work; sign-in is locked after
 * a few wrong tries, so what is left to refuse is what anyone would guess first.
 */
export const PASSWORD_RULES = [
  `at least ${PASSWORD_MIN_LENGTH} characters, anything you like`,
  'not something anyone would guess first, like "password123", "12345678" or your email address',
  'different from your last 5 passwords',
] as const;

/** Words that, with only digits and symbols around them, are what anyone tries first. */
const COMMON_WORDS = new Set([
  'password', 'passw', 'passwd', 'pass', 'pwd', 'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'welcome', 'letmein',
  'admin', 'administrator', 'changeme', 'iloveyou', 'abc', 'abcd', 'abcdef', 'test', 'user', 'login', 'secret', 'default',
]);

/** Look-alikes between two letters read as the letter: "p@ssw0rd" is "password". */
const LEET: [RegExp, string][] = [[/(?<=[a-z])[@4](?=[a-z])/g, 'a'], [/(?<=[a-z])0(?=[a-z])/g, 'o'], [/(?<=[a-z])3(?=[a-z])/g, 'e'], [/(?<=[a-z])[$5](?=[a-z])/g, 's'], [/(?<=[a-z])[1!](?=[a-z])/g, 'i']];
/** "Password@123" -> "password"; "P@ssw0rd!" -> "password"; "12345678" -> "". */
const lettersOf = (lower: string) => LEET.reduce((s, [re, to]) => s.replace(re, to), lower).replace(/[^a-z]/g, '');

/** Every character one step after the last (12345678, abcdefgh) or one step before it. */
function isRun(value: string): boolean {
  if (value.length < 4) return false;
  const step = value.charCodeAt(1) - value.charCodeAt(0);
  if (Math.abs(step) !== 1) return false;
  for (let i = 2; i < value.length; i++) if (value.charCodeAt(i) - value.charCodeAt(i - 1) !== step) return false;
  return true;
}

export interface PasswordProblem { path: string; message: string }

/** Validates a proposed password. Returns [] when it is acceptable. */
export function checkPasswordStrength(password: string, context: { email?: string; name?: string | null } = {}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const value = password.normalize('NFKC');

  if (value.length < PASSWORD_MIN_LENGTH) problems.push({ path: 'password', message: `must be at least ${PASSWORD_MIN_LENGTH} characters` });
  if (value.length > PASSWORD_MAX_LENGTH) problems.push({ path: 'password', message: `must be at most ${PASSWORD_MAX_LENGTH} characters` });
  // Refused rather than trimmed: typed again without the space at sign-in, it would not match.
  if (value.trim() !== value) problems.push({ path: 'password', message: 'must not start or end with a space' });

  const lower = value.toLowerCase();
  const letters = lettersOf(lower);
  const guessable = /^(.)\1+$/.test(value) || isRun(lower)
    // A common word dressed up with digits and symbols: "Password@123", "qwerty12345".
    || COMMON_WORDS.has(letters) || (letters === '' && (isRun(lower.replace(/\D/g, '')) || /^(\d)\1+$/.test(lower.replace(/\D/g, ''))));
  if (guessable) problems.push({ path: 'password', message: 'is too easy to guess; avoid "password123", "qwerty" or "12345678"' });

  // The email itself, or its part before the @, as the whole password. Adding to it is fine.
  const email = (context.email ?? '').trim().toLowerCase();
  const local = email.split('@')[0] ?? '';
  if (email && (lower === email || (local.length >= 3 && lower === local))) problems.push({ path: 'password', message: 'must not be your email address' });
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
