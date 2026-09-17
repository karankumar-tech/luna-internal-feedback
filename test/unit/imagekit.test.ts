import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { ImageKitClient, uploadAuthParams, withTransformation } from '../../src/modules/uploads/imagekit.js';

describe('imagekit helpers', () => {
  it('signs token+expire with HMAC-SHA1 hex and caps expiry at one hour', () => {
    const now = new Date('2026-09-17T10:00:00Z');
    const a = uploadAuthParams('private_test_key', 900, now);
    expect(a.expire).toBe(Math.floor(now.getTime() / 1000) + 900);
    expect(a.signature).toBe(createHmac('sha1', 'private_test_key').update(a.token + String(a.expire)).digest('hex'));
    expect(uploadAuthParams('k', 99999, now).expire - Math.floor(now.getTime() / 1000)).toBe(3600);
  });
  it('accepts only URLs under our endpoint', () => {
    const ik = new ImageKitClient({ publicKey: 'p', privateKey: 's', urlEndpoint: 'https://ik.imagekit.io/acct/custom-endpoint/', folder: '/shots' });
    expect(ik.accountId).toBe('acct');
    expect(ik.isOurUrl('https://ik.imagekit.io/acct/shots/a.png')).toBe(true);                 // media-library URL (account root)
    expect(ik.isOurUrl('https://ik.imagekit.io/acct/custom-endpoint/shots/a.png?tr=w-100')).toBe(true);
    expect(ik.isOurUrl('https://ik.imagekit.io/other/shots/a.png')).toBe(false);
    expect(ik.isOurUrl('https://ik.imagekit.io/acctx/a.png')).toBe(false);
    expect(ik.isOurUrl('http://ik.imagekit.io/acct/a.png')).toBe(false);
    expect(ik.isOurUrl('not a url')).toBe(false);
  });
  it('adds a transformation while keeping the URL intact', () => {
    expect(withTransformation('https://ik.imagekit.io/a/b/c.png', 'w-320')).toBe('https://ik.imagekit.io/a/b/c.png?tr=w-320');
    expect(withTransformation('https://ik.imagekit.io/a/b/c.png?x=1', 'w-320')).toBe('https://ik.imagekit.io/a/b/c.png?x=1&tr=w-320');
  });
});
