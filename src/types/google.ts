/**
 * Google API types for Sandi Ads
 */

/** Google service identifiers */
export type GoogleService =
  | 'gtm'
  | 'analytics'
  | 'searchConsole'
  | 'ads'
  | 'businessProfile'
  | 'indexing'
  | 'pagespeed'
  | 'safeBrowsing';

/** Token information */
export interface TokenInfo {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
}

/** Google OAuth scopes by service */
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  gtm: [
    'https://www.googleapis.com/auth/tagmanager.readonly',
    'https://www.googleapis.com/auth/tagmanager.edit.containers',
    'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
    'https://www.googleapis.com/auth/tagmanager.publish',
    'https://www.googleapis.com/auth/tagmanager.manage.users',
  ],
  analytics: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/analytics.manage.users',
  ],
  searchConsole: [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/webmasters',
  ],
  ads: ['https://www.googleapis.com/auth/adwords'],
  businessProfile: ['https://www.googleapis.com/auth/business.manage'],
  indexing: ['https://www.googleapis.com/auth/indexing'],
  // These use API keys, not OAuth
  pagespeed: [],
  safeBrowsing: [],
};

/** Get all required scopes for OAuth */
export function getAllScopes(): string[] {
  const allScopes = new Set<string>();
  for (const scopes of Object.values(GOOGLE_SCOPES)) {
    for (const scope of scopes) {
      allScopes.add(scope);
    }
  }
  return Array.from(allScopes);
}

/** Check if a service requires OAuth (vs API key) */
export function requiresOAuth(service: GoogleService): boolean {
  return GOOGLE_SCOPES[service].length > 0;
}

// ============================================
// GTM Types
// ============================================

export interface GTMAccount {
  accountId: string;
  name: string;
  shareData: boolean;
  fingerprint: string;
  path: string;
  tagManagerUrl: string;
}

export interface GTMContainer {
  accountId: string;
  containerId: string;
  name: string;
  publicId: string;
  usageContext: string[];
  fingerprint: string;
  path: string;
  tagManagerUrl: string;
}

export interface GTMWorkspace {
  accountId: string;
  containerId: string;
  workspaceId: string;
  name: string;
  description?: string;
  fingerprint: string;
  path: string;
  tagManagerUrl: string;
}

export interface GTMParameter {
  type: string;
  key: string;
  value?: string;
  list?: GTMParameter[];
  map?: GTMParameter[];
}

export interface GTMTag {
  accountId: string;
  containerId: string;
  workspaceId: string;
  tagId: string;
  name: string;
  type: string;
  firingTriggerId: string[];
  blockingTriggerId?: string[];
  parameter: GTMParameter[];
  fingerprint: string;
  parentFolderId?: string;
  paused?: boolean;
  path: string;
  tagManagerUrl: string;
}

export interface GTMTrigger {
  accountId: string;
  containerId: string;
  workspaceId: string;
  triggerId: string;
  name: string;
  type: string;
  filter?: GTMCondition[];
  autoEventFilter?: GTMCondition[];
  customEventFilter?: GTMCondition[];
  fingerprint: string;
  path: string;
  tagManagerUrl: string;
}

export interface GTMCondition {
  type: string;
  parameter: GTMParameter[];
}

export interface GTMVariable {
  accountId: string;
  containerId: string;
  workspaceId: string;
  variableId: string;
  name: string;
  type: string;
  parameter: GTMParameter[];
  fingerprint: string;
  path: string;
  tagManagerUrl: string;
}

// ============================================
// GA4 Types
// ============================================

export interface GA4Account {
  name: string;
  displayName: string;
  createTime: string;
  updateTime: string;
  regionCode?: string;
}

export interface GA4Property {
  name: string;
  displayName: string;
  propertyType: string;
  createTime: string;
  updateTime: string;
  parent?: string;
  industryCategory?: string;
  timeZone: string;
  currencyCode: string;
}

export interface GA4DateRange {
  startDate: string;
  endDate: string;
  name?: string;
}

export interface GA4Dimension {
  name: string;
}

export interface GA4Metric {
  name: string;
}

export interface GA4FilterExpression {
  andGroup?: { expressions: GA4FilterExpression[] };
  orGroup?: { expressions: GA4FilterExpression[] };
  notExpression?: GA4FilterExpression;
  filter?: {
    fieldName: string;
    stringFilter?: {
      matchType: 'EXACT' | 'BEGINS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'FULL_REGEXP' | 'PARTIAL_REGEXP';
      value: string;
      caseSensitive?: boolean;
    };
    inListFilter?: {
      values: string[];
      caseSensitive?: boolean;
    };
    numericFilter?: {
      operation: 'EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL';
      value: { int64Value?: string; doubleValue?: number };
    };
    betweenFilter?: {
      fromValue: { int64Value?: string; doubleValue?: number };
      toValue: { int64Value?: string; doubleValue?: number };
    };
  };
}

export interface GA4OrderBy {
  dimension?: { dimensionName: string; orderType?: 'ALPHANUMERIC' | 'CASE_INSENSITIVE_ALPHANUMERIC' | 'NUMERIC' };
  metric?: { metricName: string };
  desc?: boolean;
}

// ============================================
// Search Console Types
// ============================================

export interface GSCSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface GSCPerformanceRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GSCSitemap {
  path: string;
  lastSubmitted: string;
  isPending: boolean;
  isSitemapsIndex: boolean;
  lastDownloaded?: string;
  warnings?: number;
  errors?: number;
  contents?: {
    type: string;
    submitted?: number;
    indexed?: number;
  }[];
}
