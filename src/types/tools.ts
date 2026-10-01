/**
 * Tool types and definitions for Website Ops MCP
 */

import { z } from 'zod';

/** Tool category */
export type ToolCategory =
  | 'google'
  | 'gtm'
  | 'analytics'
  | 'searchConsole'
  | 'ads'
  | 'businessProfile'
  | 'pagespeed'
  | 'performance'
  | 'indexing'
  | 'security'
  | 'seo'
  | 'accessibility'
  | 'monitoring'
  | 'cloudflare'
  | 'utilities'
  | 'reports'
  | 'meta';

/** Tool category constants for convenience */
export const ToolCategory = {
  GOOGLE: 'google' as const,
  GTM: 'gtm' as const,
  ANALYTICS: 'analytics' as const,
  SEARCH_CONSOLE: 'searchConsole' as const,
  ADS: 'ads' as const,
  BUSINESS_PROFILE: 'businessProfile' as const,
  PAGESPEED: 'pagespeed' as const,
  PERFORMANCE: 'performance' as const,
  INDEXING: 'indexing' as const,
  SECURITY: 'security' as const,
  SEO: 'seo' as const,
  ACCESSIBILITY: 'accessibility' as const,
  MONITORING: 'monitoring' as const,
  CLOUDFLARE: 'cloudflare' as const,
  UTILITIES: 'utilities' as const,
  REPORTS: 'reports' as const,
  META: 'meta' as const,
};

/** Base tool definition */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Tool name (follows pattern: {module}_{action}_{target}) */
  name: string;
  /** Tool description for Claude */
  description: string;
  /** Tool category */
  category: ToolCategory;
  /** Input schema (Zod) */
  inputSchema: z.ZodTypeAny;
  /** Handler function */
  handler: (input: TInput) => Promise<TOutput>;
  /** Whether this tool requires authentication */
  requiresAuth?: boolean;
  /** Specific service for rate limiting */
  service?: string;
}

/** Type-safe tool definition for internal use */
export interface TypedToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
  requiresAuth?: boolean;
  service?: string;
}

/** Tool registry type */
export type ToolRegistry = Map<string, ToolDefinition>;

/** Common pagination input */
export const PaginationSchema = z.object({
  pageSize: z.number().min(1).max(200).optional(),
  pageToken: z.string().optional(),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;

/** Common date range input */
export const DateRangeSchema = z.object({
  startDate: z.string().describe('Start date in YYYY-MM-DD format or relative (today, yesterday, NdaysAgo)'),
  endDate: z.string().describe('End date in YYYY-MM-DD format or relative'),
});

export type DateRangeInput = z.infer<typeof DateRangeSchema>;

/** URL validation schema */
export const UrlSchema = z.string().url().describe('Valid URL');

/** Domain validation schema */
export const DomainSchema = z.string().regex(
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
  'Invalid domain format'
);

/** Common output wrapper */
export interface ToolOutput<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metadata?: {
    cached?: boolean;
    cachedAt?: string;
    executionTime?: number;
  };
}

/** Paginated response */
export interface PaginatedResponse<T> {
  items: T[];
  nextPageToken?: string;
  totalCount?: number;
}

/** Helper to create successful output */
export function successOutput<T>(data: T, metadata?: ToolOutput<T>['metadata']): ToolOutput<T> {
  return {
    success: true,
    data,
    metadata,
  };
}

/** Helper to create error output */
export function errorOutput(code: string, message: string, details?: unknown): ToolOutput<never> {
  return {
    success: false,
    error: { code, message, details },
  };
}
