import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const m = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../../src/dashboard/auth.js', () => ({
  authenticateRequest: () => ({ authenticated: true, role: 'admin' }),
}));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { remove: m.remove } }));

const { handleSitesRoute } = await import('../../src/dashboard/routes/sites.js');

const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function del() {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = 'DELETE';
  req.headers = {};
  (req as unknown as PassThrough).end();
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = body; },
  } as unknown as ServerResponse;
  await handleSitesRoute(req, res, `/api/sites/${siteId}`);
  return { status: out.status ?? 200, body: JSON.parse(out.body ?? '{}') };
}

beforeEach(() => m.remove.mockReset());

describe('DELETE /api/sites/:id with social posts', () => {
  const fkError = () => Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
  it.each([
    ['a pg error', fkError()],
    ['a driver-wrapped pg error', Object.assign(new Error('Failed query'), { cause: fkError() })],
  ])('maps a foreign-key block (%s) to a Spanish 409', async (_label, err) => {
    m.remove.mockRejectedValueOnce(err);
    const r = await del();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Este cliente tiene publicaciones; cancélalas o archívalas antes de borrarlo.');
  });
  it('still deletes a client without posts', async () => {
    m.remove.mockResolvedValueOnce(true);
    expect((await del()).status).toBe(200);
  });
});
