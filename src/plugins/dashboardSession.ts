import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'luna_dash';

/** Derives the HMAC secret from the dashboard key so rotating the key invalidates every session. */
export function sessionSecretFrom(dashboardKey: string): string {
  return createHash('sha256').update(`luna-dashboard-session:${dashboardKey}`).digest('hex');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(secret: string, payload: string, sig: string): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(secret, payload));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Token = `<expiry epoch ms>.<hmac>`. Stateless: nothing to store server-side. */
export function makeSessionToken(secret: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const payload = String(expiresAt);
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

/** Returns the expiry (ms) for a valid, unexpired token, else null. */
export function verifySessionToken(secret: string, token: string, now = Date.now()): number | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d{1,16}$/.test(payload)) return null;
  if (!signatureMatches(secret, payload, sig)) return null;
  const exp = Number(payload);
  return exp > now ? exp : null;
}

/**
 * Break-glass session for SUPERADMIN_EMAIL: `s.<expiry>.<hmac>`.
 *
 * Carries no user id because the super admin has no row to point at — that is the whole point
 * of it. The email comes from configuration at request time, so changing the variable changes
 * who it is, and rotating DASHBOARD_KEY (which the signing secret derives from) ends it.
 */
export function makeSuperSessionToken(secret: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const payload = `s.${expiresAt}`;
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

/** Returns the expiry (ms) for a valid, unexpired super-admin token, else null. */
export function verifySuperSessionToken(secret: string, token: string, now = Date.now()): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 's') return null;
  const [, expiryRaw, sig] = parts as [string, string, string];
  if (!/^\d{1,16}$/.test(expiryRaw)) return null;
  if (!signatureMatches(secret, `s.${expiryRaw}`, sig)) return null;
  const expiresAt = Number(expiryRaw);
  return expiresAt > now ? expiresAt : null;
}

export interface UserSession {
  userId: string;
  /** password_set_at when the session was issued, so a rotation invalidates older sessions. */
  passwordEpoch: number;
  expiresAt: number;
}

/**
 * Token for a named account: `u.<userId>.<passwordEpoch>.<expiry>.<hmac>`.
 *
 * Still stateless, but it names the user, so every request rebuilds the actor (and therefore
 * the role) from the database rather than trusting anything in the cookie. Carrying the
 * password timestamp means changing a password signs out that account's other sessions.
 */
export function makeUserSessionToken(secret: string, userId: string, passwordSetAt: Date, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const payload = `u.${userId}.${passwordSetAt.getTime()}.${expiresAt}`;
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

/** Parses and verifies a user token. Returns null for anything malformed, forged or expired. */
export function verifyUserSessionToken(secret: string, token: string, now = Date.now()): UserSession | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'u') return null;
  const [, userId, epochRaw, expiryRaw, sig] = parts as [string, string, string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(userId) || !/^\d{1,16}$/.test(epochRaw) || !/^\d{1,16}$/.test(expiryRaw)) return null;
  if (!signatureMatches(secret, `u.${userId}.${epochRaw}.${expiryRaw}`, sig)) return null;
  const expiresAt = Number(expiryRaw);
  if (expiresAt <= now) return null;
  return { userId, passwordEpoch: Number(epochRaw), expiresAt };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
