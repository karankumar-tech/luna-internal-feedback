import { describe, expect, it } from 'vitest';
import { ImageKitClient } from '../../src/modules/uploads/imagekit.js';
import { S3ScreenshotStore } from '../../src/modules/uploads/s3.js';
import { ScreenshotStorage } from '../../src/modules/uploads/screenshots.js';

// Presigning is local work (no network): fixed credentials are enough to check what gets signed.
const clientOptions = { credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret' } };
const store = new S3ScreenshotStore({ bucket: 'pulse-shots', publicBaseUrl: 'https://pulse.lunazone.com/', region: 'ap-south-1', clientOptions });

describe('S3 screenshot store', () => {
  it('hands out a PUT link for one file, with its type and exact size signed', async () => {
    const t = await store.uploadTarget('image/jpeg', 318_204);
    expect(t.method).toBe('PUT');
    expect(t.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(t.file_id).toMatch(/^s3-[0-9a-f-]{36}$/);
    expect(t.url).toBe(`https://pulse.lunazone.com/v1/screenshots/${t.file_id}`);
    const u = new URL(t.upload_url);
    expect(u.host).toBe('pulse-shots.s3.ap-south-1.amazonaws.com');
    expect(u.pathname).toBe(`/screenshots/${t.file_id.slice(3)}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(u.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    // No checksum of an empty body signed in: S3 would refuse the real file with it.
    expect([...u.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
  });

  it('signs a short-lived GET for viewing', async () => {
    const u = new URL(await store.viewUrl('s3-7f0c2b1e-1111-4222-8333-444455556666'));
    expect(u.pathname).toBe('/screenshots/7f0c2b1e-1111-4222-8333-444455556666');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('accepts only its own links and well-formed ids', () => {
    const id = 's3-7f0c2b1e-1111-4222-8333-444455556666';
    expect(store.isOurUrl(`https://pulse.lunazone.com/v1/screenshots/${id}`)).toBe(true);
    expect(store.isOurUrl(`https://elsewhere.example/v1/screenshots/${id}`)).toBe(false);
    expect(store.isOurUrl('https://pulse.lunazone.com/v1/screenshots/s3-../../etc')).toBe(false);
    expect(store.isOurUrl(`https://pulse.lunazone.com/v1/screenshots/${id}/x`)).toBe(false);
    expect(S3ScreenshotStore.isFileId('68c9f1e2a1b2c3d4e5f6a7b8')).toBe(false);
  });
});

describe('screenshot storage across S3 and ImageKit', () => {
  const deleted: string[] = [];
  const s3 = new (class extends S3ScreenshotStore {
    override async deleteFile(id: string) { deleted.push(`s3:${id}`); return true; }
  })({ bucket: 'pulse-shots', publicBaseUrl: 'https://pulse.lunazone.com', region: 'ap-south-1', clientOptions });
  const imagekit = new ImageKitClient({
    publicKey: 'public_test_key', privateKey: 'private_test_key', urlEndpoint: 'https://ik.imagekit.io/testacct', folder: '/shots',
    fetchImpl: async (input) => { deleted.push(`ik:${String(input).split('/').pop()}`); return new Response('', { status: 204 }); },
  });
  const storage = new ScreenshotStorage(imagekit, s3);
  const s3Id = 's3-7f0c2b1e-1111-4222-8333-444455556666';

  it('accepts links from either store', () => {
    expect(storage.isOurUrl(`https://pulse.lunazone.com/v1/screenshots/${s3Id}`)).toBe(true);
    expect(storage.isOurUrl('https://ik.imagekit.io/testacct/shots/old.jpg')).toBe(true);
    expect(storage.isOurUrl('https://ik.imagekit.io/someoneelse/shots/old.jpg')).toBe(false);
  });

  it('deletes each file from the store that holds it', async () => {
    await storage.deleteFile(s3Id);
    await storage.deleteFile('68c9f1e2a1b2c3d4e5f6a7b8');
    expect(deleted).toEqual([`s3:${s3Id}`, 'ik:68c9f1e2a1b2c3d4e5f6a7b8']);
  });

  it('without ImageKit keys, old ImageKit files are left alone rather than failing', async () => {
    expect(await new ScreenshotStorage(null, s3).deleteFile('68c9f1e2a1b2c3d4e5f6a7b8')).toBe(false);
  });
});
