/**
 * Configuration types for Website Ops MCP
 */

export interface AuthConfig {
  /** Service Account authentication (recommended for server-to-server) */
  serviceAccount?: {
    /** Path to JSON key file */
    keyFile: string;
    /** Email to impersonate for domain-wide delegation */
    impersonateUser?: string;
  };

  /** OAuth 2.0 authentication (for user-specific access) */
  oauth?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken?: string;
  };

  /** API Keys for public Google APIs */
  apiKeys?: {
    pagespeed?: string;
    safeBrowsing?: string;
  };
}

export interface CloudflareConfig {
  /** API Token (recommended) */
  apiToken?: string;
  /** Legacy: Email + API Key */
  email?: string;
  apiKey?: string;
}

export interface SiteConfig {
  /** Unique site identifier */
  id: string;
  /** Display name */
  name: string;
  /** Primary URL */
  url: string;

  /** Google service configurations */
  google?: {
    analytics?: {
      propertyId: string;
    };
    searchConsole?: {
      siteUrl: string;
    };
    tagManager?: {
      accountId: string;
      containerId: string;
      workspaceId?: string;
    };
    ads?: {
      customerId: string;
      managerId?: string;
    };
    businessProfile?: {
      accountId: string;
      locationId?: string;
    };
  };

  /** Cloudflare configuration */
  cloudflare?: {
    zoneId: string;
    accountId?: string;
  };

  /** Default settings */
  defaults?: {
    dateRange?: {
      preset: '7d' | '30d' | '90d' | 'ytd';
    };
    timezone?: string;
  };
}

export interface ServerConfig {
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /** Cache configuration */
  cache: {
    /** TTL in seconds */
    ttl: number;
    /** Maximum items in memory cache */
    maxItems: number;
    /** File cache directory */
    directory?: string;
  };

  /** Rate limiting */
  rateLimit: {
    enabled: boolean;
  };
}

export interface AppConfig {
  auth: AuthConfig;
  cloudflare?: CloudflareConfig;
  sites: SiteConfig[];
  server: ServerConfig;
}

/** Cache TTL by data type (in seconds) */
export const CACHE_TTL = {
  // Frequently changing - no cache or very short
  realtime: 0,
  uptime: 60,

  // Moderately stable - 5 minutes
  performance: 300,
  analytics: 300,
  searchQueries: 300,

  // Stable data - 1 hour
  siteConfig: 3600,
  propertyList: 3600,
  containerList: 3600,

  // Very stable - 24 hours
  metadata: 86400,
  technology: 86400,
} as const;

/** Rate limits by service */
export const RATE_LIMITS = {
  // Google APIs
  gtm: { requests: 50, window: 60000 }, // 50 per minute
  analytics: { requests: 100, window: 60000 }, // 100 per minute
  searchConsole: { requests: 1200, window: 86400000 }, // 1200 per day
  ads: { requests: 15000, window: 86400000 }, // 15000 per day
  businessProfile: { requests: 10, window: 60000 }, // 10 per minute — Google's default GBP quota is very low (often 1 QPM for new projects)
  pagespeed: { requests: 400, window: 86400000 }, // 400 per day
  safeBrowsing: { requests: 10000, window: 86400000 }, // 10000 per day
  indexing: { requests: 200, window: 86400000 }, // 200 per day

  // External services
  cloudflare: { requests: 1200, window: 300000 }, // 1200 per 5 minutes
  sslLabs: { requests: 25, window: 86400000 }, // 25 per day (be respectful)
  meta: { requests: 120, window: 60000 }, // 120 per minute (Graph API enforces its own per-app budget; this keeps us well under)
} as const;

export type ServiceName = keyof typeof RATE_LIMITS;
