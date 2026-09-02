import { describe, expect, it } from 'vitest';
import { makeSessionToken, readCookie, sessionSecretFrom, verifySessionToken } from '../../src/plugins/dashboardSession.js';

describe('dashboard session tokens', () => {
  const secret = sessionSecretFrom('a-dashboard-key-1234');
  it('round-trips and expires', () => {
    const { token, expiresAt } = makeSessionToken(secret, 1000, 1_000_000);
    expect(verifySessionToken(secret, token, 1_000_500)).toBe(expiresAt);
    expect(verifySessionToken(secret, token, 1_001_001)).toBeNull();
  });
  it('rejects tampering and other secrets', () => {
    const { token } = makeSessionToken(secret, 1000, 1_000_000);
    const [exp, sig] = token.split('.') as [string, string];
    expect(verifySessionToken(secret, `${Number(exp) + 5000}.${sig}`, 1_000_000)).toBeNull();
    expect(verifySessionToken(sessionSecretFrom('other'), token, 1_000_000)).toBeNull();
    expect(verifySessionToken(secret, 'garbage', 1_000_000)).toBeNull();
    expect(verifySessionToken(secret, '', 1_000_000)).toBeNull();
  });
  it('reads a cookie out of a header', () => {
    expect(readCookie('a=1; luna_dash=abc%2Edef; b=2', 'luna_dash')).toBe('abc.def');
    expect(readCookie('a=1', 'luna_dash')).toBeUndefined();
    expect(readCookie(undefined, 'luna_dash')).toBeUndefined();
  });
});
