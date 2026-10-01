/**
 * In-app Google OAuth flow.
 *
 *   buildAuthUrl(scopes) → URL to redirect user to Google consent screen
 *   exchangeAndSave(code) → exchanges code, fetches userinfo, persists account
 *
 * The OAuth Client ID/Secret come from env (the same OAuth app the user
 * registered in Google Cloud Console). The redirect URI must be registered
 * there explicitly: http://localhost:3737/api/oauth/google/callback
 *
 * State (CSRF) is held in an in-memory map with 5-minute TTL. Server
 * restart loses pending flows, which is acceptable for single-user setups.
 */

import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import { getAllScopes } from '../../types/google.js';
import { googleAccountsStore } from './google-accounts-store.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('google-oauth-flow');

const STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = new Map<string, { createdAt: number; redirectAfter?: string; browserNonce: string }>();

function pruneStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of pendingStates) {
    if (v.createdAt < cutoff) pendingStates.delete(k);
  }
}

function getOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no configurados. Configurá tu app OAuth en Google Cloud Console y agregá las credenciales al .env.',
    );
  }
  // Always use our in-app callback URI, not whatever was used by the legacy CLI script
  const redirectUri = process.env.OAUTH_REDIRECT_URI || 'http://localhost:3737/api/oauth/google/callback';
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

/**
 * Returns the URL to redirect the user to. Caller should respond with 302
 * to this URL or open it in a popup.
 */
export function buildAuthUrl(redirectAfter?: string): { url: string; state: string; browserNonce: string } {
  pruneStates();
  const client = getOAuthClient();
  const state = randomBytes(24).toString('hex');
  const browserNonce = randomBytes(24).toString('hex');
  pendingStates.set(state, { createdAt: Date.now(), redirectAfter, browserNonce });

  const scopes = [
    'openid',
    'email',
    'profile',
    ...getAllScopes(),
  ];

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent select_account',  // force account picker + ensure refresh_token
    state,
    include_granted_scopes: true,
  });

  log.info('OAuth auth URL generated', { state, scopeCount: scopes.length });
  return { url, state, browserNonce };
}

interface GoogleUserInfo {
  email: string;
  name?: string;
  picture?: string;
}

async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10_000,
  });
  return {
    email: String(res.data.email || ''),
    name: res.data.name ? String(res.data.name) : undefined,
    picture: res.data.picture ? String(res.data.picture) : undefined,
  };
}

/**
 * Validate state, exchange code, fetch userinfo, persist account.
 * Returns the saved account summary.
 */
export async function exchangeAndSave(code: string, state: string, browserNonce?: string): Promise<{
  account: { id: string; email: string; name: string | null; pictureUrl: string | null };
  redirectAfter?: string;
}> {
  pruneStates();
  const pending = pendingStates.get(state);
  if (!pending || !browserNonce || pending.browserNonce !== browserNonce) {
    throw new Error('OAuth state inválido o expirado. Reintentá la conexión.');
  }
  pendingStates.delete(state);

  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google no devolvió un refresh_token. Esto pasa si la cuenta ya autorizó la app antes — revocá el acceso en https://myaccount.google.com/permissions y reintentá.',
    );
  }
  if (!tokens.access_token) {
    throw new Error('Token exchange completed without an access_token.');
  }

  const userInfo = await fetchUserInfo(tokens.access_token);
  if (!userInfo.email) {
    throw new Error('No se pudo obtener el email del usuario desde Google');
  }

  const grantedScopes = (tokens.scope || '').split(' ').filter(Boolean);

  const saved = await googleAccountsStore.save({
    email: userInfo.email,
    name: userInfo.name ?? null,
    pictureUrl: userInfo.picture ?? null,
    refreshToken: tokens.refresh_token,
    scopes: grantedScopes,
  });

  log.info('Google account linked', { email: saved.email });
  return {
    account: { id: saved.id, email: saved.email, name: saved.name, pictureUrl: saved.pictureUrl },
    redirectAfter: pending.redirectAfter,
  };
}

/**
 * Best-effort token revocation when unlinking. Does not throw — the local
 * row gets deleted regardless so the user can always clean up.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    await axios.post(
      'https://oauth2.googleapis.com/revoke',
      new URLSearchParams({ token: refreshToken }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5_000 },
    );
  } catch (err) {
    log.warn('Token revoke failed (continuing with local delete)', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
