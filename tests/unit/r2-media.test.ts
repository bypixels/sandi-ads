import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { storePostImage } from '../../src/dashboard/services/r2-media.js';
import { ErrorCode, MCPError } from '../../src/types/errors.js';

const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'r2-super-secret-value';
const fetchMock = vi.fn();

const image = (width: number, height: number, format: 'png' | 'jpeg' | 'gif' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: '#3366ff' } }).toFormat(format).toBuffer();

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(MCPError);
    return { code: (err as MCPError).code, message: (err as MCPError).message };
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  vi.stubEnv('R2_ACCOUNT_ID', 'acc123');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'AKID');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', SECRET);
  vi.stubEnv('R2_BUCKET', 'posts');
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com/');
  fetchMock.mockReset().mockResolvedValue(new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('storePostImage', () => {
  it('converts PNG to JPEG, caps width at 1440 and PUTs to the R2 bucket with image/jpeg', async () => {
    const out = await storePostImage(siteId, await image(2000, 2000));
    expect(out.width).toBe(1440);
    expect(out.height).toBe(1440);
    expect(out.key).toMatch(new RegExp(`^sites/${siteId}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.jpg$`));
    expect(out.url).toBe(`https://media.example.com/${out.key}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`https://acc123.r2.cloudflarestorage.com/posts/${out.key}`);
    expect(req.headers.get('content-type')).toBe('image/jpeg');
    const body = Buffer.from(await req.arrayBuffer());
    expect(body.length).toBe(out.bytes);
    expect((await sharp(body).metadata()).format).toBe('jpeg');
  });
  it('does not upscale small images', async () => {
    const out = await storePostImage(siteId, await image(800, 1000, 'jpeg'));
    expect([out.width, out.height]).toEqual([800, 1000]);
  });
  it('rejects input larger than 8 MB before decoding', async () => {
    const r = await codeOf(storePostImage(siteId, Buffer.alloc(8 * 1024 * 1024 + 1)));
    expect(r.code).toBe(ErrorCode.INVALID_INPUT);
    expect(r.message).toMatch(/8 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects undecodable data and unsupported formats', async () => {
    expect((await codeOf(storePostImage(siteId, Buffer.from('not an image')))).code).toBe(ErrorCode.INVALID_INPUT);
    expect((await codeOf(storePostImage(siteId, await image(100, 100, 'gif')))).message).toMatch(/JPEG, PNG o WebP/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects aspect ratios outside 4:5 .. 1.91:1 instead of cropping', async () => {
    for (const [w, h] of [[400, 1000], [2000, 1000]]) {
      const r = await codeOf(storePostImage(siteId, await image(w, h)));
      expect(r.code).toBe(ErrorCode.INVALID_INPUT);
      expect(r.message).toMatch(/proporción/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects images over 40 megapixels quickly, before decoding, in Spanish', async () => {
    const big = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#3366ff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(big.length).toBeLessThan(8 * 1024 * 1024);
    const started = Date.now();
    const r = await codeOf(storePostImage(siteId, big));
    expect(Date.now() - started).toBeLessThan(500);
    expect(r.code).toBe(ErrorCode.INVALID_INPUT);
    expect(r.message).toMatch(/megapíxeles/);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 20000);
  it('aspect ratio accounts for EXIF orientation (5-8 swap width and height)', async () => {
    const landscapeStoredAsPortrait = await sharp({ create: { width: 1000, height: 700, channels: 3, background: '#3366ff' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await codeOf(storePostImage(siteId, landscapeStoredAsPortrait))).message).toMatch(/proporción/);
    const ok = await sharp({ create: { width: 700, height: 1000, channels: 3, background: '#3366ff' } })
      .jpeg().withMetadata({ orientation: 8 }).toBuffer();
    const out = await storePostImage(siteId, ok);
    expect([out.width, out.height]).toEqual([1000, 700]);
  });
  it('missing R2 config → AUTH_NOT_CONFIGURED in Spanish', async () => {
    vi.stubEnv('R2_SECRET_ACCESS_KEY', '');
    const r = await codeOf(storePostImage(siteId, await image(100, 100)));
    expect(r.code).toBe(ErrorCode.AUTH_NOT_CONFIGURED);
    expect(r.message).toMatch(/no está configurado/);
  });
  it('rejects a non-uuid siteId (key path safety)', async () => {
    expect((await codeOf(storePostImage('../x', await image(100, 100)))).code).toBe(ErrorCode.INVALID_INPUT);
  });
  it('R2 errors never leak the secret', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`denied for ${SECRET}`, { status: 403 }));
    const a = await codeOf(storePostImage(siteId, await image(100, 100)));
    expect(a.code).toBe(ErrorCode.EXTERNAL_SERVICE_ERROR);
    expect(a.message).not.toContain(SECRET);
    fetchMock.mockRejectedValueOnce(new Error(`socket closed ${SECRET}`));
    const b = await codeOf(storePostImage(siteId, await image(100, 100)));
    expect(b.message).not.toContain(SECRET);
  });
});
