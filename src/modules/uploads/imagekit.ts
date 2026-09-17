import { createHmac, randomUUID } from 'node:crypto';

export interface ImageKitConfig {
  publicKey: string;
  privateKey: string;
  /** e.g. https://ik.imagekit.io/noisekaranikid/noise-feedback-dashboard */
  urlEndpoint: string;
  /** e.g. /luna-feedback-screenshots */
  folder: string;
  fetchImpl?: typeof fetch;
}

export const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
export const IMAGEKIT_API_URL = 'https://api.imagekit.io/v1';

/**
 * Parameters for a client-side upload (the app talks to ImageKit directly; the private key never leaves the server).
 * signature = HMAC-SHA1(privateKey, token + expire) as hex, per ImageKit's SDKs. `expire` must be within the next hour.
 */
export function uploadAuthParams(privateKey: string, ttlSeconds = 15 * 60, now: Date = new Date()): { token: string; expire: number; signature: string } {
  const token = randomUUID();
  const expire = Math.floor(now.getTime() / 1000) + Math.min(Math.max(ttlSeconds, 60), 3600);
  const signature = createHmac('sha1', privateKey).update(token + String(expire)).digest('hex');
  return { token, expire, signature };
}

export class ImageKitClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: ImageKitConfig) { this.fetchImpl = cfg.fetchImpl ?? fetch; }

  get urlEndpoint(): string { return this.cfg.urlEndpoint.replace(/\/+$/, ''); }
  get folder(): string { return this.cfg.folder; }
  get publicKey(): string { return this.cfg.publicKey; }

  authParams(ttlSeconds?: number): { token: string; expire: number; signature: string } {
    return uploadAuthParams(this.cfg.privateKey, ttlSeconds);
  }

  /** The account segment of the URL endpoint, e.g. "noisekaranikid" for https://ik.imagekit.io/noisekaranikid[/anything]. */
  get accountId(): string {
    return new URL(this.urlEndpoint).pathname.split('/').filter(Boolean)[0] ?? '';
  }

  /**
   * True when a URL belongs to this ImageKit account (only such URLs are accepted on submissions).
   * Media-library uploads are served from https://ik.imagekit.io/<account>/…, regardless of custom URL endpoints.
   */
  isOurUrl(url: string): boolean {
    try {
      const u = new URL(url);
      const ep = new URL(this.urlEndpoint);
      const account = this.accountId;
      return u.protocol === 'https:' && u.host === ep.host && account !== '' && u.pathname.startsWith(`/${account}/`);
    } catch { return false; }
  }

  /** Delete a file by id. Best effort: returns false on any failure instead of throwing. */
  async deleteFile(fileId: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${IMAGEKIT_API_URL}/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: { authorization: 'Basic ' + Buffer.from(this.cfg.privateKey + ':').toString('base64') },
      });
      return res.ok || res.status === 404;
    } catch { return false; }
  }
}

/** Append an ImageKit transformation (e.g. "w-320") to a URL, preserving existing query params. */
export function withTransformation(url: string, tr: string): string {
  try { const u = new URL(url); u.searchParams.set('tr', tr); return u.toString(); } catch { return url; }
}
