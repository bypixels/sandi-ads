/**
 * Settings API routes — credential management
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../auth.js';
import {
  credentialStore,
  CREDENTIAL_SCHEMA,
  CREDENTIAL_GROUPS,
} from '../services/credential-store.js';
import { authManager } from '../../auth/index.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody } from './route-helpers.js';

const log = createServiceLogger('settings-api');

/**
 * Handle settings routes. Returns true if matched.
 */
export async function handleSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // All settings routes require auth
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }

  // GET /api/settings/schema — credential structure for UI
  if (pathname === '/api/settings/schema' && req.method === 'GET') {
    sendJson(res, {
      groups: CREDENTIAL_GROUPS,
      schema: CREDENTIAL_SCHEMA,
    });
    return true;
  }

  // GET /api/settings/credentials — which credentials are configured (no values)
  if (pathname === '/api/settings/credentials' && req.method === 'GET') {
    const status = credentialStore.getStatus();
    const authStatus = await authManager.getStatus();

    sendJson(res, {
      credentials: status,
      auth: authStatus,
    });
    return true;
  }

  // POST /api/settings/credentials — save credentials
  if (pathname === '/api/settings/credentials' && req.method === 'POST') {
    try {
      const body = await parseBody(req) as Record<string, string>;

      // Validate keys are known
      const validKeys = Object.keys(CREDENTIAL_SCHEMA);
      const unknownKeys = Object.keys(body).filter(k => !validKeys.includes(k));
      if (unknownKeys.length > 0) {
        sendJson(res, { error: `Unknown credential keys: ${unknownKeys.join(', ')}` }, 400);
        return true;
      }

      // Save to encrypted store
      credentialStore.set(body);

      // Apply to env and re-initialize auth
      credentialStore.applyToEnv();
      await authManager.reinitialize();

      const status = credentialStore.getStatus();
      const authStatus = await authManager.getStatus();

      log.info('Credentials updated', { keys: Object.keys(body) });

      sendJson(res, {
        message: 'Credentials saved and applied',
        credentials: status,
        auth: authStatus,
      });
    } catch (error) {
      log.error('Failed to save credentials', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      sendJson(res, { error: 'Failed to save credentials' }, 500);
    }
    return true;
  }

  // DELETE /api/settings/credentials/:key
  const deleteMatch = pathname.match(/^\/api\/settings\/credentials\/([a-z_]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const key = deleteMatch[1];

    if (!CREDENTIAL_SCHEMA[key]) {
      sendJson(res, { error: `Unknown credential key: ${key}` }, 400);
      return true;
    }

    credentialStore.remove(key);

    // Remove from env
    const envVar = CREDENTIAL_SCHEMA[key].envVar;
    delete process.env[envVar];

    // Re-initialize auth
    await authManager.reinitialize();

    sendJson(res, {
      message: `Credential '${key}' removed`,
      credentials: credentialStore.getStatus(),
    });
    return true;
  }

  // POST /api/settings/credentials/validate — test if credentials work
  if (pathname === '/api/settings/credentials/validate' && req.method === 'POST') {
    try {
      const authStatus = await authManager.getStatus();

      const results: Record<string, { configured: boolean; working: boolean; message: string }> = {};

      // Check Google OAuth
      const hasOAuth = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
      results.google_oauth = {
        configured: hasOAuth,
        working: authStatus.method === 'oauth' && authStatus.isAuthenticated,
        message: hasOAuth
          ? (authStatus.method === 'oauth' ? 'OAuth active' : 'OAuth configured but not active')
          : 'Not configured',
      };

      // Check Service Account
      const hasSA = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
      results.google_service_account = {
        configured: hasSA,
        working: authStatus.method === 'service-account' && authStatus.isAuthenticated,
        message: hasSA
          ? (authStatus.method === 'service-account' ? 'Service account active' : 'Configured but not active')
          : 'Not configured',
      };

      // Check API Keys
      results.google_api_keys = {
        configured: authStatus.apiKeys.pagespeed || authStatus.apiKeys.safeBrowsing,
        working: authStatus.apiKeys.pagespeed || authStatus.apiKeys.safeBrowsing,
        message: `PageSpeed: ${authStatus.apiKeys.pagespeed ? 'Yes' : 'No'}, Safe Browsing: ${authStatus.apiKeys.safeBrowsing ? 'Yes' : 'No'}`,
      };

      // Check Cloudflare
      const hasCF = !!process.env.CLOUDFLARE_API_TOKEN || (!!process.env.CLOUDFLARE_EMAIL && !!process.env.CLOUDFLARE_API_KEY);
      results.cloudflare = {
        configured: hasCF,
        working: hasCF, // Can't easily validate without an API call
        message: hasCF ? 'Configured' : 'Not configured',
      };

      // Check Google Ads
      const hasAds = !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
      results.google_ads = {
        configured: hasAds,
        working: hasAds && authStatus.isAuthenticated,
        message: hasAds ? 'Developer token configured' : 'Not configured',
      };

      sendJson(res, { validation: results });
    } catch (error) {
      log.error('Credential validation failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      sendJson(res, { error: 'Validation failed' }, 500);
    }
    return true;
  }

  // POST /api/settings/credentials/clear — remove all credentials
  if (pathname === '/api/settings/credentials/clear' && req.method === 'POST') {
    credentialStore.clear();

    // Remove all from env
    for (const schema of Object.values(CREDENTIAL_SCHEMA)) {
      delete process.env[schema.envVar];
    }

    await authManager.reinitialize();

    sendJson(res, { message: 'All credentials cleared' });
    return true;
  }

  return false;
}
