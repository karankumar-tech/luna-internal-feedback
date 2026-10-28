import { randomUUID } from 'node:crypto';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

export interface S3ScreenshotConfig {
  bucket: string;
  /** Empty: the SDK's own region (AWS_REGION, set on EKS). */
  region?: string;
  /** Where this server is reached; screenshot links are `${publicBaseUrl}/v1/screenshots/<file_id>`. */
  publicBaseUrl: string;
  /** Test seam: extra client options (fixed credentials). In production the default chain finds the pod's role. */
  clientOptions?: S3ClientConfig;
}

/** S3 screenshots are `s3-<uuid>`; ImageKit's own ids never start that way. */
const FILE_ID = /^s3-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Every S3 screenshot lives under this prefix, so the bucket can hold other things. */
const KEY_PREFIX = 'screenshots/';
/** How long an upload link works. */
const UPLOAD_TTL_S = 10 * 60;
/** How long a view link works; the redirect to it is cached a little less. */
export const VIEW_TTL_S = 60 * 60;

/**
 * Screenshots in a private S3 bucket. The app and the dashboard PUT the file straight to S3 with a
 * short-lived presigned link, so files never pass through the server. A screenshot's link is ours
 * (/v1/screenshots/<file_id>) and redirects to a presigned GET, so the bucket stays private and the
 * link never expires. Credentials come from the SDK's default chain: the pod's IAM role (IRSA) on EKS.
 *
 * The SDK is imported on first use only, so a server without S3 (Vercel today) never loads it.
 */
export class S3ScreenshotStore {
  private clientP: Promise<S3Client> | null = null;
  private readonly base: string;

  constructor(private readonly cfg: S3ScreenshotConfig) {
    this.base = cfg.publicBaseUrl.replace(/\/+$/, '');
  }

  private client(): Promise<S3Client> {
    // Checksums only when S3 requires them: by default the SDK signs a CRC32 of the (empty) body into
    // presigned PUT links, and S3 then refuses the real file the browser or app sends.
    this.clientP ??= import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({
      ...(this.cfg.region ? { region: this.cfg.region } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...this.cfg.clientOptions,
    }));
    return this.clientP;
  }

  static isFileId(fileId: string): boolean { return FILE_ID.test(fileId); }
  private static key(fileId: string): string { return KEY_PREFIX + fileId.slice('s3-'.length); }

  linkFor(fileId: string): string { return `${this.base}/v1/screenshots/${fileId}`; }

  /** True for a link this store handed out: our base URL, then a well-formed S3 file id. */
  isOurUrl(url: string): boolean {
    const prefix = `${this.base}/v1/screenshots/`;
    return url.startsWith(prefix) && S3ScreenshotStore.isFileId(url.slice(prefix.length));
  }

  /**
   * A link to PUT one file. Its type and exact size are signed, so S3 refuses any other body,
   * and the caller must send `content-type` as given.
   */
  async uploadTarget(contentType: string, size: number) {
    const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
    const fileId = `s3-${randomUUID()}`;
    const command = new PutObjectCommand({ Bucket: this.cfg.bucket, Key: S3ScreenshotStore.key(fileId), ContentType: contentType, ContentLength: size });
    const uploadUrl = await getSignedUrl(await this.client(), command, {
      expiresIn: UPLOAD_TTL_S,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      method: 'PUT' as const, upload_url: uploadUrl, headers: { 'content-type': contentType },
      expires_in: UPLOAD_TTL_S, file_id: fileId, url: this.linkFor(fileId),
    };
  }

  /** A presigned GET for one screenshot. */
  async viewUrl(fileId: string): Promise<string> {
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
    return getSignedUrl(await this.client(), new GetObjectCommand({ Bucket: this.cfg.bucket, Key: S3ScreenshotStore.key(fileId) }), { expiresIn: VIEW_TTL_S });
  }

  /** Delete a file by id. Best effort: returns false on any failure instead of throwing. */
  async deleteFile(fileId: string): Promise<boolean> {
    if (!S3ScreenshotStore.isFileId(fileId)) return false;
    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: S3ScreenshotStore.key(fileId) }));
      return true;
    } catch { return false; }
  }
}
