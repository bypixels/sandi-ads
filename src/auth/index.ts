/**
 * Authentication module - unified interface for all auth methods
 */

import { GoogleOAuth, createOAuthFromEnv, createOAuthFromRefreshToken } from './google-oauth.js';
import { ServiceAccountAuth, createServiceAccountFromEnv } from './service-account.js';
import { ApiKeyManager, apiKeyManager } from './api-keys.js';
import { GoogleService, requiresOAuth } from '../types/google.js';
import { MCPError, ErrorCode } from '../types/errors.js';
import { createServiceLogger } from '../utils/logger.js';

const log = createServiceLogger('auth');

export { GoogleOAuth, ServiceAccountAuth, ApiKeyManager };
export { apiKeyManager };
export { createOAuthFromEnv, createServiceAccountFromEnv };

export type AuthMethod = 'oauth' | 'service-account' | 'api-key' | 'none';

export interface AuthStatus {
  method: AuthMethod;
  isAuthenticated: boolean;
  details?: {
    email?: string;
    projectId?: string;
    scopes?: string[];
    expiresAt?: string;
  };
  apiKeys: {
    pagespeed: boolean;
    safeBrowsing: boolean;
  };
}

/**
 * Unified authentication manager
 */
class AuthManager {
  private oauth: GoogleOAuth | null = null;
  private serviceAccount: ServiceAccountAuth | null = null;
  private preferredMethod: AuthMethod = 'none';
  private initialized = false;
  private activeAccountEmail: string | null = null;

  /**
   * Initialize authentication from environment variables
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    log.info('Initializing authentication...');

    // Try Service Account first (preferred for server-to-server)
    try {
      this.serviceAccount = await createServiceAccountFromEnv();
      if (this.serviceAccount?.isConfigured()) {
        this.preferredMethod = 'service-account';
        log.info('Using service account authentication');
      }
    } catch (error) {
      log.error('Failed to initialize service account', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    // Try OAuth — prefer DB-linked account, fall back to env
    try {
      let dbAccountUsed: { id: string; email: string } | null = null;
      try {
        // Lazy import to avoid circular dep with dashboard/db
        const { googleAccountsStore } = await import('../dashboard/services/google-accounts-store.js');
        const acct = await googleAccountsStore.getDefaultActive();
        if (acct) {
          this.oauth = await createOAuthFromRefreshToken(acct.refreshToken);
          if (this.oauth) {
            dbAccountUsed = { id: acct.id, email: acct.email };
            await googleAccountsStore.markUsed(acct.id);
          }
        }
      } catch (err) {
        log.debug('DB-linked account not available, will try env fallback', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }

      if (!this.oauth) {
        this.oauth = await createOAuthFromEnv();
      }

      if (this.oauth && !this.serviceAccount?.isConfigured()) {
        this.preferredMethod = 'oauth';
        if (dbAccountUsed) {
          this.activeAccountEmail = dbAccountUsed.email;
          log.info('Using OAuth authentication (DB account)', { email: dbAccountUsed.email });
        } else {
          log.info('Using OAuth authentication (env fallback)');
        }
      }
    } catch (error) {
      log.error('Failed to initialize OAuth', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    // API keys are always available via apiKeyManager
    const apiKeyStatus = apiKeyManager.getStatus();
    log.info('API keys status', apiKeyStatus);

    if (this.preferredMethod === 'none') {
      log.warn(
        'No Google authentication configured. Some tools will not be available.'
      );
    }

    this.initialized = true;
  }

  /**
   * Get access token for a Google service
   */
  async getAccessToken(service: GoogleService): Promise<string> {
    // Check if service requires OAuth or can use API key
    if (!requiresOAuth(service)) {
      // Service can use API key instead
      const key = apiKeyManager.getKey(service as 'pagespeed' | 'safeBrowsing');
      if (key) {
        return key; // Return API key as token (handled differently by each service)
      }
    }

    // Try service account first
    if (this.serviceAccount?.isAuthenticated()) {
      return this.serviceAccount.getAccessToken(service);
    }

    // Try OAuth
    if (this.oauth?.isAuthenticated()) {
      return this.oauth.getAccessToken(service);
    }

    throw new MCPError({
      code: ErrorCode.AUTH_NOT_CONFIGURED,
      message: `No authentication configured for ${service}. Configure OAuth or Service Account credentials.`,
      retryable: false,
      service,
    });
  }

  /**
   * Get authentication status
   */
  async getStatus(): Promise<AuthStatus> {
    const status: AuthStatus = {
      method: this.preferredMethod,
      isAuthenticated: false,
      apiKeys: apiKeyManager.getStatus(),
    };

    if (this.preferredMethod === 'service-account' && this.serviceAccount) {
      status.isAuthenticated = this.serviceAccount.isAuthenticated();
      const info = this.serviceAccount.getInfo();
      if (info) {
        status.details = {
          email: info.email,
          projectId: info.projectId,
        };
      }
    } else if (this.preferredMethod === 'oauth' && this.oauth) {
      status.isAuthenticated = this.oauth.isAuthenticated();
      const tokenInfo = this.oauth.getTokenInfo();
      status.details = {
        ...(this.activeAccountEmail ? { email: this.activeAccountEmail } : {}),
        ...(tokenInfo ? { scopes: tokenInfo.scopes, expiresAt: tokenInfo.expiresAt.toISOString() } : {}),
      };
    }

    return status;
  }

  /**
   * Get OAuth client for generating auth URL
   */
  getOAuth(): GoogleOAuth | null {
    return this.oauth;
  }

  /**
   * Get service account auth
   */
  getServiceAccount(): ServiceAccountAuth | null {
    return this.serviceAccount;
  }

  /**
   * Check if authenticated for a specific service
   */
  canAccessService(service: GoogleService): boolean {
    if (!requiresOAuth(service)) {
      // Can use API key
      return apiKeyManager.hasKey(service as 'pagespeed' | 'safeBrowsing');
    }

    return (
      this.serviceAccount?.isAuthenticated() || this.oauth?.isAuthenticated() || false
    );
  }

  /**
   * Get preferred auth method
   */
  getPreferredMethod(): AuthMethod {
    return this.preferredMethod;
  }

  /**
   * Re-initialize authentication (e.g., after credentials change).
   * Resets state and re-reads from current process.env.
   */
  async reinitialize(): Promise<void> {
    log.info('Re-initializing authentication...');

    this.oauth = null;
    this.serviceAccount = null;
    this.preferredMethod = 'none';
    this.activeAccountEmail = null;
    this.initialized = false;

    // Re-initialize the apiKeyManager from current env
    // Clear keys first, then re-set only if present in env
    apiKeyManager.clear();
    const pagespeedKey = process.env.GOOGLE_PAGESPEED_API_KEY;
    const safeBrowsingKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
    if (pagespeedKey) apiKeyManager.setKey('pagespeed', pagespeedKey);
    if (safeBrowsingKey) apiKeyManager.setKey('safeBrowsing', safeBrowsingKey);

    await this.initialize();
  }

  /**
   * Reset authentication state
   */
  async reset(): Promise<void> {
    if (this.oauth) {
      await this.oauth.revoke();
    }

    this.oauth = null;
    this.serviceAccount = null;
    this.preferredMethod = 'none';
    this.initialized = false;

    log.info('Authentication reset');
  }
}

/** Singleton auth manager */
export const authManager = new AuthManager();

export default authManager;
