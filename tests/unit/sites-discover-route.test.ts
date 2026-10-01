import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('../../src/dashboard/auth.js', () => ({
  authenticateRequest: () => ({ authenticated: true }),
}));
vi.mock('../../src/dashboard/services/sites-discover.js', () => ({
  discoverSiteBindings: vi.fn().mockRejectedValue(new Error('internal detail: token=SECRET-123 at /srv/app')),
}));

const { handleSitesRoute } = await import('../../src/dashboard/routes/sites.js');

function fakeReq(body: string): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  (req as unknown as PassThrough).end(body);
  return req;
}

function fakeRes(): { res: ServerResponse; out: { status?: number; body?: string } } {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = body; },
  } as unknown as ServerResponse;
  return { res, out };
}

describe('POST /api/sites/discover errors', () => {
  it('returns a generic message and never echoes internal error text', async () => {
    const { res, out } = fakeRes();
    await handleSitesRoute(fakeReq(JSON.stringify({ url: 'https://example.com' })), res, '/api/sites/discover');
    expect(out.status).toBe(500);
    expect(out.body).not.toContain('SECRET-123');
    expect(JSON.parse(out.body ?? '{}')).toEqual({ error: 'Discovery failed' });
  });
});
