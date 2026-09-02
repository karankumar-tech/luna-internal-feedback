import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'luna_dash';

/** Derives the HMAC secret from the dashboard key so rotating the key invalidates every session. */
export function sessionSecretFrom(dashboardKey: string): string {
  return createHash('sha256').update(`luna-dashboard-session:${dashboardKey}`).digest('hex');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
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
  const expected = sign(secret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(payload);
  return exp > now ? exp : null;
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
