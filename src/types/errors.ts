/**
 * Error types and codes for Sandi Ads
 */

export enum ErrorCode {
  // Authentication errors
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  AUTH_INSUFFICIENT_SCOPE = 'AUTH_INSUFFICIENT_SCOPE',
  AUTH_NOT_CONFIGURED = 'AUTH_NOT_CONFIGURED',

  // Rate limiting errors
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',

  // Validation errors
  INVALID_INPUT = 'INVALID_INPUT',
  INVALID_PARAMS = 'INVALID_PARAMS',
  INVALID_URL = 'INVALID_URL',
  INVALID_DATE_RANGE = 'INVALID_DATE_RANGE',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',

  // Resource errors
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_ACCESS_DENIED = 'RESOURCE_ACCESS_DENIED',

  // External service errors
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  EXTERNAL_SERVICE_TIMEOUT = 'EXTERNAL_SERVICE_TIMEOUT',
  EXTERNAL_SERVICE_UNAVAILABLE = 'EXTERNAL_SERVICE_UNAVAILABLE',

  // Internal errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export interface MCPErrorDetails {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  retryAfter?: number;
  service?: string;
}

/**
 * Custom error class for MCP operations
 */
export class MCPError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly retryable: boolean;
  public readonly retryAfter?: number;
  public readonly service?: string;

  constructor(options: MCPErrorDetails) {
    super(options.message);
    this.name = 'MCPError';
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable;
    this.retryAfter = options.retryAfter;
    this.service = options.service;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MCPError);
    }
  }

  /**
   * Convert to JSON for MCP response
   */
  toJSON(): MCPErrorDetails {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      service: this.service,
    };
  }

  /**
   * Create an authentication error
   */
  static authError(
    message: string,
    code: ErrorCode = ErrorCode.AUTH_INVALID_CREDENTIALS
  ): MCPError {
    return new MCPError({
      code,
      message,
      retryable: code === ErrorCode.AUTH_TOKEN_EXPIRED,
    });
  }

  /**
   * Create a rate limit error
   */
  static rateLimitError(service: string, retryAfter?: number): MCPError {
    return new MCPError({
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
      message: `Rate limit exceeded for ${service}`,
      retryable: true,
      retryAfter,
      service,
    });
  }

  /**
   * Create a validation error
   */
  static validationError(
    message: string,
    details?: Record<string, unknown>
  ): MCPError {
    return new MCPError({
      code: ErrorCode.INVALID_INPUT,
      message,
      details,
      retryable: false,
    });
  }

  /**
   * Create a not found error
   */
  static notFoundError(resource: string): MCPError {
    return new MCPError({
      code: ErrorCode.RESOURCE_NOT_FOUND,
      message: `Resource not found: ${resource}`,
      retryable: false,
    });
  }

  /**
   * Create an external service error
   */
  static externalServiceError(
    service: string,
    message: string,
    retryable = true
  ): MCPError {
    return new MCPError({
      code: ErrorCode.EXTERNAL_SERVICE_ERROR,
      message: `${service}: ${message}`,
      retryable,
      service,
    });
  }

  /**
   * Create a configuration error
   */
  static configError(message: string): MCPError {
    return new MCPError({
      code: ErrorCode.CONFIGURATION_ERROR,
      message,
      retryable: false,
    });
  }
}
