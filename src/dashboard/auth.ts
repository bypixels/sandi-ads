import type { IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface AuthResult {
  authenticated: boolean;
  role?: 'admin' | 'reviewer';
  reason?: string;
}

function matches(value: string, secret: string | undefined): boolean {
  return !!secret && timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(secret).digest());
}

export function authenticateRequest(req: IncomingMessage): AuthResult {
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (!apiKey && process.env.DASHBOARD_AUTH_REQUIRED === 'false') {
    return { authenticated: true, role: 'admin' };
  }
  if (!apiKey) return { authenticated: false, reason: 'DASHBOARD_API_KEY not configured' };
  const reviewerKey = process.env.DASHBOARD_REVIEWER_API_KEY;
  if (reviewerKey && reviewerKey === apiKey) return { authenticated: false, reason: 'Las llaves de administrador y revisor deben ser distintas.' };
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const header = req.headers['x-api-key'];
  const tokens = [bearer, typeof header === 'string' ? header : undefined].filter((v): v is string => !!v);
  if (tokens.some(token => matches(token, apiKey))) return { authenticated: true, role: 'admin' };
  if (tokens.some(token => matches(token, reviewerKey)) && process.env.WEBSITE_OPS_SITE_ID) {
    return { authenticated: true, role: 'reviewer' };
  }
  return { authenticated: false, reason: 'Invalid or missing API key' };
}

/** Reviewer capability is deliberately narrow, not an unrestricted client login. */
export function authorizeEndpoint(auth: AuthResult, method: string, pathname: string): boolean {
  if (!auth.authenticated) return false;
  if (auth.role === 'admin') return true;
  return (method === 'GET' && ['/api/health', '/api/agent/pending-approvals', '/api/mutations/status'].includes(pathname))
    || (method === 'POST' && pathname === '/api/agent/approve');
}
