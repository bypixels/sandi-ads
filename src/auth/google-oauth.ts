/**
 * Google OAuth 2.0 authentication.
 *
 * Each instance owns:
 *   - the underlying OAuth2Client (the SDK does its own token refresh, but
 *     we also drive it explicitly for predictable behavior).
 *   - the current Credentials (access_token, refresh_token, scope, expiry).
 *   - a refresh-coalescing Promise so concurrent callers wait on one refresh.
 *
 * No global singleton. Multiple instances coexist (preparation for
 * per-Site account selection in iteration 2 of multi-account).
 */

import { OAuth2Client, Credentials } from 'google-auth-library';
import { GoogleService, TokenInfo, GOOGLE_SCOPES, getAllScopes } from '../types/google.js';
import { MCPError, ErrorCode } from '../types/errors.js';
import { createServiceLogger } from '../utils/logger.js';

const log = createServiceLogger('google-oauth');

/** Refresh access tokens this many ms before they actually expire. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken?: string;
}

export class GoogleOAuth {
  private readonly oauth2Client: OAuth2Client;
  private tokens: Credentials | null = null;
  private tokenExpiry: Date | null = null;
  private refreshInflight: Promise<void> | null = null;

  constructor(config: OAuthConfig) {
    this.oauth2Client = new OAuth2Client(
      config.clientId,
      config.clientSecret,
      config.redirectUri,
    );

    // The SDK fires this when it auto-refreshes during a call. Keep our
    // tracked credentials in sync so explicit getAccessToken() reflects
    // the new expiry.
    this.oauth2Client.on('tokens', (newTokens) => {
      log.info('Tokens refreshed by SDK');
      this.applyTokens(newTokens);
    });

    log.info('OAuth client initialized');
  }

  /**
   * Initialize with an existing refresh token and force one refresh so we
   * have a usable access token in hand.
   */
  async initializeWithRefreshToken(refreshToken: string): Promise<void> {
    log.info('Initializing OAuth with refresh token');
    this.applyTokens({ refresh_token: refreshToken });
    await this.refresh();
  }

  /** Generate the authorization URL for the consent screen. */
  generateAuthUrl(options?: {
    accessType?: 'online' | 'offline';
    prompt?: 'none' | 'consent' | 'select_account';
    state?: string;
  }): string {
    const scopes = getAllScopes();
    const url = this.oauth2Client.generateAuthUrl({
      access_type: options?.accessType || 'offline',
      scope: scopes,
      prompt: options?.prompt || 'consent',
      state: options?.state,
      include_granted_scopes: true,
    });
    log.info('Generated auth URL', { scopes: scopes.length });
    return url;
  }

  /** Exchange an authorization code for tokens and persist them. */
  async exchangeCode(code: string): Promise<Credentials> {
    log.info('Exchanging authorization code for tokens');
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      if (!tokens.refresh_token) {
        log.warn('No refresh token received. User may need to re-consent with prompt=consent');
      }
      this.applyTokens(tokens);
      log.info('Token exchange successful', {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
      });
      return tokens;
    } catch (error) {
      log.error('Token exchange failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new MCPError({
        code: ErrorCode.AUTH_INVALID_CREDENTIALS,
        message: `Token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        retryable: false,
      });
    }
  }

  /** The bare OAuth2Client, used by googleapis SDKs as `auth:` parameter. */
  getClient(): OAuth2Client {
    return this.oauth2Client;
  }

  /** True when we hold an access token and an OAuth client. */
  isAuthenticated(): boolean {
    return !!this.tokens?.access_token;
  }

  /** Static info about the current token (for status displays). */
  getTokenInfo(): TokenInfo | null {
    if (!this.tokens?.access_token || !this.tokenExpiry) return null;
    return {
      accessToken: this.tokens.access_token,
      expiresAt: this.tokenExpiry,
      scopes: this.tokens.scope?.split(' ') || [],
    };
  }

  /**
   * Get a valid access token. Refreshes if expired or about to expire
   * (5 minute buffer). Verifies that the token's granted scopes cover
   * the requested service.
   */
  async getAccessToken(service?: GoogleService): Promise<string> {
    if (!this.tokens) {
      throw new MCPError({
        code: ErrorCode.AUTH_NOT_CONFIGURED,
        message: 'OAuth not configured. Please authenticate first.',
        retryable: false,
      });
    }

    const expiringSoon =
      this.tokenExpiry && this.tokenExpiry.getTime() - REFRESH_BUFFER_MS < Date.now();
    if (expiringSoon) {
      await this.refresh();
    }

    if (!this.tokens.access_token) {
      throw new MCPError({
        code: ErrorCode.AUTH_TOKEN_EXPIRED,
        message: 'Access token not available',
        retryable: true,
      });
    }

    if (service && this.tokens.scope) {
      const required = GOOGLE_SCOPES[service];
      if (required && required.length > 0) {
        const granted = this.tokens.scope;
        const missing = required.filter((s) => !granted.includes(s));
        if (missing.length > 0) {
          throw new MCPError({
            code: ErrorCode.AUTH_INSUFFICIENT_SCOPE,
            message: `Missing required scopes for ${service}: ${missing.join(', ')}. Re-authenticate with the correct scopes.`,
            details: {
              required,
              current: granted.split(' '),
              missing,
            },
            retryable: false,
            service,
          });
        }
      }
    }

    return this.tokens.access_token;
  }

  /**
   * Refresh the access token. Concurrent callers share one in-flight
   * refresh — the second caller awaits the first's Promise.
   */
  async refresh(): Promise<void> {
    if (this.refreshInflight) return this.refreshInflight;
    this.refreshInflight = this.doRefresh().finally(() => {
      this.refreshInflight = null;
    });
    return this.refreshInflight;
  }

  /** Revoke tokens server-side and forget them locally. */
  async revoke(): Promise<void> {
    if (!this.tokens?.access_token) return;
    log.info('Revoking tokens...');
    try {
      await this.oauth2Client.revokeToken(this.tokens.access_token);
      this.tokens = null;
      this.tokenExpiry = null;
      log.info('Tokens revoked successfully');
    } catch (error) {
      log.error('Token revocation failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  /**
   * Persist new credentials, recalculate the local expiry mirror, and
   * push them into the OAuth2Client so the SDK uses them on next call.
   */
  private applyTokens(tokens: Credentials): void {
    // Preserve refresh_token across refreshes — Google omits it on refresh
    // responses but we still need it for the next refresh.
    if (!tokens.refresh_token && this.tokens?.refresh_token) {
      tokens.refresh_token = this.tokens.refresh_token;
    }
    this.tokens = tokens;
    if (tokens.expiry_date) {
      this.tokenExpiry = new Date(tokens.expiry_date);
    } else if (tokens.access_token) {
      // Default to 1 hour if expiry wasn't reported.
      this.tokenExpiry = new Date(Date.now() + 3600 * 1000);
    }
    this.oauth2Client.setCredentials(tokens);
    log.debug('Tokens updated', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresAt: this.tokenExpiry?.toISOString(),
    });
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new MCPError({
        code: ErrorCode.AUTH_TOKEN_EXPIRED,
        message: 'No refresh token available. Please re-authenticate.',
        retryable: false,
      });
    }
    log.info('Refreshing access token...');
    try {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.applyTokens(credentials);
      log.info('Token refreshed successfully');
    } catch (error) {
      log.error('Token refresh failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new MCPError({
        code: ErrorCode.AUTH_TOKEN_EXPIRED,
        message: `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        retryable: false,
      });
    }
  }
}

/** Create OAuth client from environment variables */
export async function createOAuthFromEnv(): Promise<GoogleOAuth | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

  if (!clientId || !clientSecret) {
    log.debug('OAuth not configured - missing client credentials');
    return null;
  }

  const oauth = new GoogleOAuth({ clientId, clientSecret, redirectUri });

  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (refreshToken) {
    await oauth.initializeWithRefreshToken(refreshToken);
  }

  return oauth;
}

/**
 * Create an OAuth client from an explicit refresh token (DB-loaded account).
 * Returns null when client credentials aren't in env — the OAuth app itself
 * still has to be registered in env to talk to Google.
 */
export async function createOAuthFromRefreshToken(refreshToken: string): Promise<GoogleOAuth | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback';
  if (!clientId || !clientSecret) return null;

  const oauth = new GoogleOAuth({ clientId, clientSecret, redirectUri });
  await oauth.initializeWithRefreshToken(refreshToken);
  return oauth;
}

export default GoogleOAuth;
