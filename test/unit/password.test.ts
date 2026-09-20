import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MIN_LENGTH, checkPasswordStrength, generatePassword, hashPassword, verifyPassword,
} from '../../src/modules/users/password.js';

describe('password hashing', () => {
  it('round-trips and rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery 7');
    expect(await verifyPassword('correct horse battery 7', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery 8', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same password 12');
    const b = await hashPassword('same password 12');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password 12', a)).toBe(true);
    expect(await verifyPassword('same password 12', b)).toBe(true);
  });

  it('records the parameters it used, so the cost can be raised later', async () => {
    const hash = await hashPassword('parameters 123');
    const [scheme, n, r, p] = hash.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(1 << 14);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('treats a malformed or empty stored hash as a non-match rather than throwing', async () => {
    for (const stored of ['', 'nonsense', 'scrypt$x$8$1$aaaa$bbbb', 'scrypt$32768$8$1$$', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything at all', stored)).toBe(false);
    }
  });

  it('normalises unicode so the same typed password matches', async () => {
    // "é" composed vs decomposed: the same password as far as a person is concerned.
    const hash = await hashPassword('café secret 12');
    expect(await verifyPassword('café secret 12', hash)).toBe(true);
  });
});

describe('password rules', () => {
  const ok = (p: string, ctx = {}) => checkPasswordStrength(p, ctx).length === 0;

  it('accepts a reasonable password', () => {
    expect(ok('luna ring 4 testing')).toBe(true);
    expect(ok('Tr0ubador-Fence')).toBe(true);
  });

  it('requires length and a mix of letters and digits', () => {
    expect(ok('short1')).toBe(false);
    expect(ok('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(false);      // no digit
    expect(ok('1'.repeat(PASSWORD_MIN_LENGTH))).toBe(false);      // no letter
    expect(ok('aaaaaaaaaaaa')).toBe(false);                        // repeated character
  });

  it('rejects obvious choices', () => {
    for (const p of ['password123', 'qwerty12345', 'letmein12345', 'Welcome1234']) {
      expect(ok(p), p).toBe(false);
    }
  });

  it('rejects a password built from the account it belongs to', () => {
    expect(ok('karan1234567', { email: 'karan@gonoise.com' })).toBe(false);
    expect(ok('kumar99887766', { email: 'k@gonoise.com', name: 'Karan Kumar' })).toBe(false);
    // A short name fragment is not enough to trip it.
    expect(ok('a-quiet-harbour-9', { email: 'a@b.com', name: 'Al' })).toBe(true);
  });

  it('rejects leading or trailing spaces', () => {
    expect(ok(' luna ring 41 ')).toBe(false);
  });

  it('names every problem at once so the form can show them together', () => {
    const problems = checkPasswordStrength('abc', { email: 'abc@x.com' });
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.every((p) => p.path === 'password')).toBe(true);
  });
});

describe('generated passwords', () => {
  it('always satisfy the rules and avoid look-alike characters', () => {
    for (let i = 0; i < 40; i += 1) {
      const p = generatePassword();
      expect(checkPasswordStrength(p), p).toEqual([]);
      expect(p).not.toMatch(/[l1IO0]/);
      expect(p.length).toBe(14);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(seen.size).toBe(50);
  });

  it('honours a requested length within bounds', () => {
    expect(generatePassword(20).length).toBe(20);
    expect(generatePassword(4).length).toBe(PASSWORD_MIN_LENGTH);
    expect(generatePassword(999).length).toBe(32);
  });
});
