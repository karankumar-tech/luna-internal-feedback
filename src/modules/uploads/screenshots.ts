import type { ImageKitClient } from './imagekit.js';
import { S3ScreenshotStore } from './s3.js';

/**
 * Where screenshots live: new ones in S3, older ones on ImageKit. Each stored screenshot keeps its
 * own link, so the dashboard shows either kind as it is; this decides which store a file id belongs
 * to when it is checked or deleted.
 */
export class ScreenshotStorage {
  constructor(readonly imagekit: ImageKitClient | null, readonly s3: S3ScreenshotStore | null) {}

  get enabled(): boolean { return this.imagekit !== null || this.s3 !== null; }

  /** True when a URL came from one of our upload flows (only such URLs are accepted on reports). */
  isOurUrl(url: string): boolean {
    return (this.s3?.isOurUrl(url) ?? false) || (this.imagekit?.isOurUrl(url) ?? false);
  }

  /** Delete a file from whichever store holds it. Best effort, like each store's own delete. */
  async deleteFile(fileId: string): Promise<boolean> {
    if (S3ScreenshotStore.isFileId(fileId)) return this.s3 ? this.s3.deleteFile(fileId) : false;
    return this.imagekit ? this.imagekit.deleteFile(fileId) : false;
  }
}
