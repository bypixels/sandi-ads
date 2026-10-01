import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCode, MCPError } from '../../src/types/errors.js';

const guarded = vi.hoisted(() => ({ guardedExecute: vi.fn() }));
vi.mock('../../src/dashboard/auth.js', () => ({ authenticateRequest: () => ({ authenticated: true, role: 'admin' }) }));
vi.mock('../../src/dashboard/services/guarded-execution.js', () => guarded);

const { handleApiRoute } = await import('../../src/dashboard/routes/api.js');

function fakeReq(): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = 'POST'; req.url = '/api/tool/ads_list_campaigns'; req.headers = { 'content-type': 'application/json' };
  (req as unknown as PassThrough).end('{}');
  return req;
}
function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = { writeHead: (s: number) => { out.status = s; }, setHeader: () => {}, end: (b: string) => { out.body = b; } } as unknown as ServerResponse;
  return { res, out };
}

describe('POST /api/tool/:name credential errors', () => {
  it.each([
    [ErrorCode.AUTH_NOT_CONFIGURED, 'CREDENTIAL_MISSING'],
    [ErrorCode.AUTH_INVALID_CREDENTIALS, 'CREDENTIAL_MISSING'],
    [ErrorCode.AUTH_INSUFFICIENT_SCOPE, 'CREDENTIAL_REJECTED'],
    [ErrorCode.AUTH_TOKEN_EXPIRED, 'CREDENTIAL_REJECTED'],
  ])('maps %s to 424 %s', async (code, bodyCode) => {
    guarded.guardedExecute.mockResolvedValue({ status: 'error', error: 'Falta token', errorDetails: new MCPError({ code, message: 'Falta token', retryable: false }).toJSON() });
    const { res, out } = fakeRes();
    await handleApiRoute(fakeReq(), res, '/api/tool/ads_list_campaigns');
    expect(out.status).toBe(424);
    expect(JSON.parse(out.body ?? '{}')).toEqual({ error: 'Falta token', code: bodyCode });
  });
  it('keeps 500 for unrelated errors', async () => {
    guarded.guardedExecute.mockResolvedValue({ status: 'error', error: 'boom' });
    const { res, out } = fakeRes();
    await handleApiRoute(fakeReq(), res, '/api/tool/ads_list_campaigns');
    expect(out.status).toBe(500);
  });
});
