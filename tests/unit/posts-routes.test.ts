import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakePostsPool } from '../helpers/social-posts-pool.js';
import { ErrorCode, MCPError } from '../../src/types/errors.js';

const m = vi.hoisted(() => ({
  fake: undefined as unknown as ReturnType<typeof import('../helpers/social-posts-pool.js').createFakePostsPool>,
  getSite: vi.fn(),
  append: vi.fn(),
  storePostImage: vi.fn(),
}));
vi.mock('../../src/db/index.js', () => ({ getPool: () => m.fake.pool }));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { get: m.getSite } }));
vi.mock('../../src/dashboard/services/audit-log.js', () => ({ auditLog: { append: m.append } }));
vi.mock('../../src/dashboard/services/r2-media.js', () => ({ storePostImage: m.storePostImage }));

const { handlePostsRoute } = await import('../../src/dashboard/routes/posts.js');
const { createDashboardServer } = await import('../../src/dashboard/http-server.js');

const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const postId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function fakeReq(method: string, url: string, body?: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = method; req.url = url;
  req.headers = { host: 'localhost:3737', 'content-type': 'application/json', ...headers };
  (req as unknown as PassThrough).end(body ?? '');
  return req;
}
function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = { writeHead: (s: number) => { out.status = s; }, setHeader: () => {}, end: (b?: string) => { out.body = b; } } as unknown as ServerResponse;
  return { res, out, json: () => JSON.parse(out.body ?? '{}') };
}
async function call(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const r = fakeRes();
  const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const handled = await handlePostsRoute(fakeReq(method, url, raw, headers), r.res, new URL(url, 'http://x').pathname);
  return { handled, status: r.out.status ?? 200, body: r.json() };
}

beforeEach(() => {
  m.fake = createFakePostsPool();
  m.getSite.mockReset().mockImplementation(async (id: string) => ({ id, bindings: { metaPageId: '111', metaIgUserId: '222' } }));
  m.append.mockReset().mockResolvedValue(undefined);
  m.storePostImage.mockReset();
  vi.stubEnv('DASHBOARD_API_KEY', '');
  vi.stubEnv('DASHBOARD_AUTH_REQUIRED', 'false');
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com');
});
afterEach(() => vi.unstubAllEnvs());

describe('posts routes — reviewer is denied everywhere', () => {
  beforeEach(() => {
    vi.stubEnv('DASHBOARD_API_KEY', 'admin-secret');
    vi.stubEnv('DASHBOARD_REVIEWER_API_KEY', 'review-secret');
    vi.stubEnv('SANDI_ADS_SITE_ID', siteA);
    vi.stubEnv('DASHBOARD_AUTH_REQUIRED', 'true');
  });
  it.each([
    ['GET', `/api/posts?siteId=${siteA}`], ['POST', '/api/posts'], ['PATCH', `/api/posts/${postId}`],
    ['POST', `/api/posts/${postId}/approve`], ['POST', `/api/posts/${postId}/reject`],
    ['POST', `/api/posts/${postId}/cancel`], ['POST', `/api/media?siteId=${siteA}`],
  ])('reviewer %s %s → 403 without touching storage', async (method, url) => {
    let status: number | undefined;
    const res = { setHeader: vi.fn(), writeHead: vi.fn((c: number) => { status = c; }), end: vi.fn() } as unknown as ServerResponse;
    const req = fakeReq(method, url, '{}', { authorization: 'Bearer review-secret' });
    await (createDashboardServer().listeners('request')[0] as (q: IncomingMessage, s: ServerResponse) => Promise<void>)(req, res);
    expect(status).toBe(403);
    expect(m.fake.statements).toEqual([]);
    expect(m.storePostImage).not.toHaveBeenCalled();
  });
  it('the route itself also refuses a reviewer role (defense in depth)', async () => {
    const r = await call('GET', `/api/posts?siteId=${siteA}`, undefined, { authorization: 'Bearer review-secret' });
    expect(r.status).toBe(403);
  });
});

describe('posts routes — admin', () => {
  const valid = { siteId: siteA, platforms: ['facebook'], message: 'Hola' };

  it('POST /api/posts creates a draft with createdBy dashboard; GET lists it', async () => {
    const r = await call('POST', '/api/posts', valid);
    expect(r.status).toBe(201);
    expect(r.body.post).toMatchObject({ status: 'draft', createdBy: 'dashboard', siteId: siteA });
    const l = await call('GET', `/api/posts?siteId=${siteA}&status=draft,approved`);
    expect(l.body.posts).toHaveLength(1);
  });
  it('validation errors → 400 with Spanish details', async () => {
    const r = await call('POST', '/api/posts', { ...valid, platforms: ['instagram'] });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/Instagram requiere una imagen/)]));
    expect(m.fake.rows.size).toBe(0);
    const bad = await call('POST', '/api/posts', { siteId: 'nope', platforms: 'facebook' });
    expect(bad.status).toBe(400);
    expect(Array.isArray(bad.body.details)).toBe(true);
  });
  it('POST approve sets approvedBy admin and writes an audit event', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    const r = await call('POST', `/api/posts/${body.post.id}/approve`, { siteId: siteA, version: body.post.version, note: 'listo' });
    expect(r.status).toBe(200);
    expect(r.body.post).toMatchObject({ status: 'approved', approvedBy: 'admin', decisionNote: 'listo' });
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({
      tool: 'social_post_approve', siteId: siteA, input: expect.objectContaining({ actor: 'admin', postId: body.post.id }),
    }));
  });
  it('approve with another site id → 404 and stays draft', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    const r = await call('POST', `/api/posts/${body.post.id}/approve`, { siteId: siteB, version: body.post.version });
    expect(r.status).toBe(404);
    expect(m.fake.rows.get(body.post.id)!.status).toBe('draft');
  });
  it('approve without an integer version → 400 in Spanish and stays draft', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    for (const version of [undefined, '1', 1.5, null]) {
      const r = await call('POST', `/api/posts/${body.post.id}/approve`, { siteId: siteA, version });
      expect(r.status).toBe(400);
      expect(r.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/versión/)]));
    }
    expect(m.fake.rows.get(body.post.id)!.status).toBe('draft');
  });
  it('approve with a stale version → 409 with the Spanish message and stays draft', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    await call('PATCH', `/api/posts/${body.post.id}`, { siteId: siteA, message: 'Editado' });
    const r = await call('POST', `/api/posts/${body.post.id}/approve`, { siteId: siteA, version: body.post.version });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('La publicación cambió desde que la revisaste; revísala de nuevo.');
    expect(m.fake.rows.get(body.post.id)).toMatchObject({ status: 'draft', message: 'Editado' });
  });
  it('reject and cancel do not need a version', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    expect((await call('POST', `/api/posts/${body.post.id}/reject`, { siteId: siteA })).status).toBe(200);
  });
  it('PATCH requires siteId and edits only drafts', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    expect((await call('PATCH', `/api/posts/${body.post.id}`, { message: 'x' })).status).toBe(400);
    const r = await call('PATCH', `/api/posts/${body.post.id}`, { siteId: siteA, message: 'Editado' });
    expect(r.body.post.message).toBe('Editado');
    await call('POST', `/api/posts/${body.post.id}/reject`, { siteId: siteA });
    expect((await call('PATCH', `/api/posts/${body.post.id}`, { siteId: siteA, message: 'y' })).status).toBe(404);
  });
  it('cancel works from approved', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    await call('POST', `/api/posts/${body.post.id}/approve`, { siteId: siteA, version: body.post.version });
    expect((await call('POST', `/api/posts/${body.post.id}/cancel`, { siteId: siteA })).body.post.status).toBe('cancelled');
  });
  it('POST /api/media passes the raw image to storePostImage', async () => {
    m.storePostImage.mockResolvedValue({ url: 'u', key: 'k', width: 1, height: 1, bytes: 3 });
    const r = await call('POST', `/api/media?siteId=${siteA}`, Buffer.from([1, 2, 3]), { 'content-type': 'image/png' });
    expect(r.status).toBe(201);
    expect(m.storePostImage).toHaveBeenCalledWith(siteA, Buffer.from([1, 2, 3]));
    expect(m.append).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'social_post_media_upload', siteId: siteA, status: 'success',
      input: expect.objectContaining({ action: 'media_upload', key: 'k', bytes: 3 }),
    }));
  });
  it('POST /api/media lowercases the siteId and 404s for an unknown site', async () => {
    m.storePostImage.mockResolvedValue({ url: 'u', key: 'k', width: 1, height: 1, bytes: 3 });
    const r = await call('POST', `/api/media?siteId=${siteA.toUpperCase()}`, Buffer.from([1]), { 'content-type': 'image/png' });
    expect(r.status).toBe(201);
    expect(m.storePostImage).toHaveBeenCalledWith(siteA, expect.any(Buffer));
    expect(m.getSite).toHaveBeenCalledWith(siteA);
    m.storePostImage.mockClear();
    m.getSite.mockResolvedValueOnce(undefined);
    const nf = await call('POST', `/api/media?siteId=${siteB}`, Buffer.from([1]), { 'content-type': 'image/png' });
    expect(nf.status).toBe(404);
    expect(m.storePostImage).not.toHaveBeenCalled();
  });
  it('POST /api/media rejects other content types and missing siteId', async () => {
    expect((await call('POST', `/api/media?siteId=${siteA}`, Buffer.from([1]), { 'content-type': 'image/gif' })).status).toBe(415);
    expect((await call('POST', '/api/media', Buffer.from([1]), { 'content-type': 'image/png' })).status).toBe(400);
    expect(m.storePostImage).not.toHaveBeenCalled();
  });
  it('POST /api/media maps validation → 400 and missing R2 config → 424', async () => {
    m.storePostImage.mockRejectedValueOnce(MCPError.validationError('Proporción no válida'));
    const v = await call('POST', `/api/media?siteId=${siteA}`, Buffer.from([1]), { 'content-type': 'image/png' });
    expect(v.status).toBe(400);
    expect(v.body.details).toEqual(['Proporción no válida']);
    m.storePostImage.mockRejectedValueOnce(MCPError.authError('R2 no está configurado', ErrorCode.AUTH_NOT_CONFIGURED));
    const c = await call('POST', `/api/media?siteId=${siteA}`, Buffer.from([1]), { 'content-type': 'image/jpeg' });
    expect(c.status).toBe(424);
    expect(c.body.code).toBe('CREDENTIAL_MISSING');
  });
});

describe('posts routes — pinned client', () => {
  beforeEach(() => vi.stubEnv('SANDI_ADS_SITE_ID', siteA));
  const valid = { platforms: ['facebook'], message: 'Hola' };

  it('GET without siteId lists only the pinned client; another siteId → 403', async () => {
    m.fake.rows.clear();
    vi.stubEnv('SANDI_ADS_SITE_ID', '');
    await call('POST', '/api/posts', { ...valid, siteId: siteB });
    vi.stubEnv('SANDI_ADS_SITE_ID', siteA);
    await call('POST', '/api/posts', valid);
    const l = await call('GET', '/api/posts');
    expect(l.status).toBe(200);
    expect(l.body.posts.map((p: { siteId: string }) => p.siteId)).toEqual([siteA]);
    expect((await call('GET', `/api/posts?siteId=${siteB}`)).status).toBe(403);
  });
  it('POST /api/posts without siteId uses the pin; another siteId → 403 without writing', async () => {
    const r = await call('POST', '/api/posts', valid);
    expect(r.status).toBe(201);
    expect(r.body.post.siteId).toBe(siteA);
    const before = m.fake.rows.size;
    expect((await call('POST', '/api/posts', { ...valid, siteId: siteB })).status).toBe(403);
    expect(m.fake.rows.size).toBe(before);
  });
  it('PATCH and decisions use the pin and refuse another siteId', async () => {
    const { body } = await call('POST', '/api/posts', valid);
    expect((await call('PATCH', `/api/posts/${body.post.id}`, { siteId: siteB, message: 'x' })).status).toBe(403);
    expect((await call('PATCH', `/api/posts/${body.post.id}`, { message: 'Editado' })).body.post.message).toBe('Editado');
    for (const action of ['approve', 'reject', 'cancel']) {
      expect((await call('POST', `/api/posts/${body.post.id}/${action}`, { siteId: siteB })).status).toBe(403);
    }
    expect(m.fake.rows.get(body.post.id)!.status).toBe('draft');
    expect((await call('POST', `/api/posts/${body.post.id}/approve`, { version: m.fake.rows.get(body.post.id)!.version })).body.post.status).toBe('approved');
  });
  it('POST /api/media uses the pin and refuses another siteId', async () => {
    m.storePostImage.mockResolvedValue({ url: 'u', key: 'k', width: 1, height: 1, bytes: 3 });
    expect((await call('POST', `/api/media?siteId=${siteB}`, Buffer.from([1]), { 'content-type': 'image/png' })).status).toBe(403);
    expect(m.storePostImage).not.toHaveBeenCalled();
    expect((await call('POST', '/api/media', Buffer.from([1]), { 'content-type': 'image/png' })).status).toBe(201);
    expect(m.storePostImage).toHaveBeenCalledWith(siteA, expect.any(Buffer));
  });
});

describe('posts routes — oversized upload over a real socket', () => {
  it('a body over 8 MB gets a 413 the client can actually read', async () => {
    const server = createDashboardServer();
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await new Promise<{ status?: number; body: string; error?: string }>((done) => {
        const req = httpRequest({
          host: '127.0.0.1', port, method: 'POST', path: `/api/media?siteId=${siteA}`,
          headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) },
        }, (res) => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => done({ status: res.statusCode, body }));
        });
        req.on('error', err => done({ body: '', error: err.message }));
        const chunk = Buffer.alloc(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 9 * 1024 * 1024) {
            sent += chunk.length;
            if (!req.write(chunk)) { req.once('drain', pump); return; }
          }
          req.end();
        };
        pump();
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(413);
      expect(JSON.parse(result.body).error).toMatch(/demasiado grande/);
      expect(m.storePostImage).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
    }
  }, 15000);
});
