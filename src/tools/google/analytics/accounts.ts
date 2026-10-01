/**
 * Google Analytics 4 - Accounts and Properties tools
 */

import { z } from 'zod';
import { getAnalyticsAdminClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GA4Account, GA4Property } from '../../../types/google.js';

const log = createServiceLogger('ga4-accounts');

// ============================================
// List Accounts
// ============================================

const listAccountsSchema = z.object({
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page (1-200)'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListAccountsInput = z.infer<typeof listAccountsSchema>;

interface ListAccountsOutput {
  accounts: GA4Account[];
  nextPageToken?: string;
}

export const ga4ListAccountsTool: ToolDefinition<ListAccountsInput, ListAccountsOutput> = {
  name: 'ga4_list_accounts',
  description: 'Lists all Google Analytics 4 accounts accessible to the authenticated user',
  category: ToolCategory.GOOGLE,
  inputSchema: listAccountsSchema,

  async handler(input: ListAccountsInput): Promise<ListAccountsOutput> {
    log.info('Listing GA4 accounts', { pageSize: input.pageSize });

    const analyticsAdmin = await getAnalyticsAdminClient();

    const response = await analyticsAdmin.accounts.list({
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    });

    const accounts: GA4Account[] = (response.data.accounts || []).map((acc) => ({
      name: acc.name || '',
      displayName: acc.displayName || '',
      createTime: acc.createTime || '',
      updateTime: acc.updateTime || '',
      regionCode: acc.regionCode || undefined,
    }));

    log.info('Listed GA4 accounts', { count: accounts.length });

    return {
      accounts,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Account
// ============================================

const getAccountSchema = z.object({
  accountId: z.string().describe('GA4 Account ID (numeric ID or full resource name)'),
});

type GetAccountInput = z.infer<typeof getAccountSchema>;

export const ga4GetAccountTool: ToolDefinition<GetAccountInput, GA4Account> = {
  name: 'ga4_get_account',
  description: 'Gets details of a specific GA4 account',
  category: ToolCategory.GOOGLE,
  inputSchema: getAccountSchema,

  async handler(input: GetAccountInput): Promise<GA4Account> {
    log.info('Getting GA4 account', input);

    const analyticsAdmin = await getAnalyticsAdminClient();
    const name = input.accountId.startsWith('accounts/')
      ? input.accountId
      : `accounts/${input.accountId}`;

    const response = await analyticsAdmin.accounts.get({ name });

    const acc = response.data;

    return {
      name: acc.name || '',
      displayName: acc.displayName || '',
      createTime: acc.createTime || '',
      updateTime: acc.updateTime || '',
      regionCode: acc.regionCode || undefined,
    };
  },
};

// ============================================
// List Properties
// ============================================

const listPropertiesSchema = z.object({
  accountId: z.string().optional().describe('Filter by account ID (optional)'),
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page (1-200)'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListPropertiesInput = z.infer<typeof listPropertiesSchema>;

interface ListPropertiesOutput {
  properties: GA4Property[];
  nextPageToken?: string;
}

export const ga4ListPropertiesTool: ToolDefinition<ListPropertiesInput, ListPropertiesOutput> = {
  name: 'ga4_list_properties',
  description: 'Lists all GA4 properties, optionally filtered by account',
  category: ToolCategory.GOOGLE,
  inputSchema: listPropertiesSchema,

  async handler(input: ListPropertiesInput): Promise<ListPropertiesOutput> {
    log.info('Listing GA4 properties', { accountId: input.accountId });

    const analyticsAdmin = await getAnalyticsAdminClient();

    // Build filter string
    let filter: string | undefined;
    if (input.accountId) {
      const accountName = input.accountId.startsWith('accounts/')
        ? input.accountId
        : `accounts/${input.accountId}`;
      filter = `parent:${accountName}`;
    }

    const response = await analyticsAdmin.properties.list({
      filter,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    });

    const properties: GA4Property[] = (response.data.properties || []).map((prop) => ({
      name: prop.name || '',
      displayName: prop.displayName || '',
      propertyType: prop.propertyType || '',
      createTime: prop.createTime || '',
      updateTime: prop.updateTime || '',
      parent: prop.parent || undefined,
      industryCategory: prop.industryCategory || undefined,
      timeZone: prop.timeZone || '',
      currencyCode: prop.currencyCode || '',
    }));

    log.info('Listed GA4 properties', { count: properties.length });

    return {
      properties,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Property
// ============================================

const getPropertySchema = z.object({
  propertyId: z.string().describe('GA4 Property ID (numeric ID or full resource name)'),
});

type GetPropertyInput = z.infer<typeof getPropertySchema>;

export const ga4GetPropertyTool: ToolDefinition<GetPropertyInput, GA4Property> = {
  name: 'ga4_get_property',
  description: 'Gets details of a specific GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: getPropertySchema,

  async handler(input: GetPropertyInput): Promise<GA4Property> {
    log.info('Getting GA4 property', input);

    const analyticsAdmin = await getAnalyticsAdminClient();
    const name = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsAdmin.properties.get({ name });

    const prop = response.data;

    return {
      name: prop.name || '',
      displayName: prop.displayName || '',
      propertyType: prop.propertyType || '',
      createTime: prop.createTime || '',
      updateTime: prop.updateTime || '',
      parent: prop.parent || undefined,
      industryCategory: prop.industryCategory || undefined,
      timeZone: prop.timeZone || '',
      currencyCode: prop.currencyCode || '',
    };
  },
};
