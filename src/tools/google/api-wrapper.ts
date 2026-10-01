/**
 * Shared utilities for Google API tool handlers.
 * Provides authenticated client creation and rate-limited API execution.
 */

import type { OAuth2Client } from 'google-auth-library';
import type { GoogleAuth } from 'google-auth-library';
import { authManager } from '../../auth/index.js';
import { MCPError, ErrorCode } from '../../types/errors.js';
import { rateLimiter } from '../../utils/rate-limiter.js';
import type { ServiceName } from '../../types/config.js';
/**
 * Get Google auth object (ServiceAccount GoogleAuth or OAuth2Client).
 * Throws MCPError if no authentication is available.
 */
export function getGoogleAuth(serviceName: string): GoogleAuth | OAuth2Client {
  const auth = authManager.getServiceAccount()?.getGoogleAuth() ||
               authManager.getOAuth()?.getClient();

  if (!auth) {
    throw new MCPError({
      code: ErrorCode.AUTH_NOT_CONFIGURED,
      message: `No authentication available for ${serviceName}. Configure OAuth or Service Account credentials.`,
      retryable: false,
      service: serviceName,
    });
  }

  return auth;
}

/**
 * Execute a Google API call with rate limiting and structured error handling.
 */
export async function executeGoogleApi<T>(
  service: ServiceName,
  fn: () => Promise<T>,
): Promise<T> {
  return rateLimiter.execute(service, async () => {
    try {
      return await fn();
    } catch (error) {
      // Don't re-wrap MCPError
      if (error instanceof MCPError) throw error;

      // Convert Google API errors (GaxiosError)
      const gaxiosError = error as { code?: number; response?: { status?: number; statusText?: string; data?: { error?: { message?: string } } }; message?: string };

      const statusCode = gaxiosError.response?.status ?? gaxiosError.code;
      const errorMessage = gaxiosError.response?.data?.error?.message
        ?? gaxiosError.message
        ?? 'Unknown Google API error';

      if (statusCode === 401 || statusCode === 403) {
        throw new MCPError({
          code: statusCode === 401 ? ErrorCode.AUTH_TOKEN_EXPIRED : ErrorCode.AUTH_INSUFFICIENT_SCOPE,
          message: `${service}: ${errorMessage}`,
          retryable: statusCode === 401,
          service,
        });
      }

      if (statusCode === 404) {
        throw new MCPError({
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: `${service}: ${errorMessage}`,
          retryable: false,
          service,
        });
      }

      if (statusCode === 429) {
        // Preserve Google's descriptive error and deduce retry timing from
        // the message — GBP and friends often return "per minute" or
        // "per day" quota limits we can map to a concrete wait time.
        const lower = errorMessage.toLowerCase();
        let retryAfter: number | undefined;
        if (lower.includes('per minute')) retryAfter = 60;
        else if (lower.includes('per hour')) retryAfter = 3600;
        else if (lower.includes('per day')) retryAfter = 86400;
        throw new MCPError({
          code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: `${service}: ${errorMessage}`,
          retryable: true,
          retryAfter,
          service,
        });
      }

      if (statusCode && statusCode >= 500) {
        throw new MCPError({
          code: ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
          message: `${service}: ${errorMessage}`,
          retryable: true,
          service,
        });
      }

      throw MCPError.externalServiceError(service, errorMessage);
    }
  });
}
