/**
 * Google Business Profile - Accounts and Locations tools
 */

import { z } from 'zod';
import { executeGoogleApi } from '../api-wrapper.js';
import {
  getAccountManagementClient,
  getBusinessInformationClient,
  getLocationsClient,
  normalizeLocationName,
} from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('gbp-accounts');

// ============================================
// List Accounts
// ============================================

const listAccountsSchema = z.object({
  pageSize: z.number().min(1).max(20).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListAccountsInput = z.infer<typeof listAccountsSchema>;

interface GBPAccount {
  name: string;
  accountName: string;
  type: string;
  role: string;
  state: string;
}

interface ListAccountsOutput {
  accounts: GBPAccount[];
  nextPageToken?: string;
}

export const gbpListAccountsTool: ToolDefinition<ListAccountsInput, ListAccountsOutput> = {
  name: 'gbp_list_accounts',
  description: 'Lists all Google Business Profile accounts accessible to the authenticated user',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: listAccountsSchema,

  async handler(input: ListAccountsInput): Promise<ListAccountsOutput> {
    log.info('Listing GBP accounts');

    const client = getAccountManagementClient();

    const response = await executeGoogleApi('businessProfile', () =>
      client.accounts.list({
        pageSize: input.pageSize,
        pageToken: input.pageToken,
      }),
    );

    const accounts: GBPAccount[] = (response.data.accounts || []).map((acc) => ({
      name: acc.name || '',
      accountName: acc.accountName || '',
      type: acc.type || '',
      role: acc.role || '',
      state: acc.verificationState || '',
    }));

    log.info('Listed GBP accounts', { count: accounts.length });

    return {
      accounts,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// List Locations
// ============================================

const listLocationsSchema = z.object({
  accountId: z.string().describe('GBP Account ID or full resource name'),
  pageSize: z.number().min(1).max(100).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
  filter: z.string().optional().describe('Filter string'),
});

type ListLocationsInput = z.infer<typeof listLocationsSchema>;

interface GBPAddress {
  regionCode: string;
  languageCode: string;
  postalCode: string;
  administrativeArea: string;
  locality: string;
  addressLines: string[];
}

interface GBPLocation {
  name: string;
  title: string;
  storeCode?: string;
  websiteUri?: string;
  phoneNumbers?: {
    primaryPhone: string;
    additionalPhones?: string[];
  };
  categories?: {
    primaryCategory: { displayName: string };
    additionalCategories?: { displayName: string }[];
  };
  address: GBPAddress;
  latlng?: {
    latitude: number;
    longitude: number;
  };
}

interface ListLocationsOutput {
  locations: GBPLocation[];
  nextPageToken?: string;
}

export const gbpListLocationsTool: ToolDefinition<ListLocationsInput, ListLocationsOutput> = {
  name: 'gbp_list_locations',
  description: 'Lists all locations/businesses for a GBP account',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: listLocationsSchema,

  async handler(input: ListLocationsInput): Promise<ListLocationsOutput> {
    log.info('Listing GBP locations', { accountId: input.accountId });

    const client = getBusinessInformationClient();

    const parent = input.accountId.startsWith('accounts/')
      ? input.accountId
      : `accounts/${input.accountId}`;

    const response = await executeGoogleApi('businessProfile', () =>
      client.accounts.locations.list({
        parent,
        pageSize: input.pageSize,
        pageToken: input.pageToken,
        filter: input.filter,
        readMask: 'name,title,storeCode,websiteUri,phoneNumbers,categories,storefrontAddress,latlng',
      }),
    );

    const locations: GBPLocation[] = (response.data.locations || []).map((loc) => ({
      name: loc.name || '',
      title: loc.title || '',
      storeCode: loc.storeCode || undefined,
      websiteUri: loc.websiteUri || undefined,
      phoneNumbers: loc.phoneNumbers ? {
        primaryPhone: loc.phoneNumbers.primaryPhone || '',
        additionalPhones: loc.phoneNumbers.additionalPhones || undefined,
      } : undefined,
      categories: loc.categories ? {
        primaryCategory: { displayName: loc.categories.primaryCategory?.displayName || '' },
        additionalCategories: loc.categories.additionalCategories?.map((c) => ({ displayName: c.displayName || '' })),
      } : undefined,
      address: {
        regionCode: loc.storefrontAddress?.regionCode || '',
        languageCode: loc.storefrontAddress?.languageCode || '',
        postalCode: loc.storefrontAddress?.postalCode || '',
        administrativeArea: loc.storefrontAddress?.administrativeArea || '',
        locality: loc.storefrontAddress?.locality || '',
        addressLines: loc.storefrontAddress?.addressLines || [],
      },
      latlng: loc.latlng ? {
        latitude: loc.latlng.latitude || 0,
        longitude: loc.latlng.longitude || 0,
      } : undefined,
    }));

    log.info('Listed GBP locations', { count: locations.length });

    return {
      locations,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Location
// ============================================

const getLocationSchema = z.object({
  name: z.string().describe('Full location resource name (accounts/{accountId}/locations/{locationId})'),
});

type GetLocationInput = z.infer<typeof getLocationSchema>;

export const gbpGetLocationTool: ToolDefinition<GetLocationInput, GBPLocation> = {
  name: 'gbp_get_location',
  description: 'Gets detailed information about a specific GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: getLocationSchema,

  async handler(input: GetLocationInput): Promise<GBPLocation> {
    log.info('Getting GBP location', { name: input.name });

    const locationsClient = getLocationsClient();
    const locationName = normalizeLocationName(input.name);

    const response = await executeGoogleApi('businessProfile', () =>
      locationsClient.get({
        name: locationName,
        readMask: 'name,title,storeCode,websiteUri,phoneNumbers,categories,storefrontAddress,latlng',
      }),
    );

    const loc = response.data as Record<string, unknown>;
    const phoneNumbers = loc.phoneNumbers as Record<string, unknown> | undefined;
    const categories = loc.categories as Record<string, unknown> | undefined;
    const storefrontAddress = loc.storefrontAddress as Record<string, unknown> | undefined;
    const latlng = loc.latlng as Record<string, number> | undefined;
    const primaryCat = categories?.primaryCategory as Record<string, unknown> | undefined;
    const additionalCats = categories?.additionalCategories as Array<Record<string, unknown>> | undefined;

    return {
      name: String(loc.name || ''),
      title: String(loc.title || ''),
      storeCode: loc.storeCode ? String(loc.storeCode) : undefined,
      websiteUri: loc.websiteUri ? String(loc.websiteUri) : undefined,
      phoneNumbers: phoneNumbers ? {
        primaryPhone: String(phoneNumbers.primaryPhone || ''),
        additionalPhones: phoneNumbers.additionalPhones as string[] | undefined,
      } : undefined,
      categories: categories ? {
        primaryCategory: { displayName: String(primaryCat?.displayName || '') },
        additionalCategories: additionalCats?.map((c: Record<string, unknown>) => ({ displayName: String(c.displayName || '') })),
      } : undefined,
      address: {
        regionCode: String(storefrontAddress?.regionCode || ''),
        languageCode: String(storefrontAddress?.languageCode || ''),
        postalCode: String(storefrontAddress?.postalCode || ''),
        administrativeArea: String(storefrontAddress?.administrativeArea || ''),
        locality: String(storefrontAddress?.locality || ''),
        addressLines: (storefrontAddress?.addressLines as string[]) || [],
      },
      latlng: latlng ? {
        latitude: Number(latlng.latitude || 0),
        longitude: Number(latlng.longitude || 0),
      } : undefined,
    };
  },
};

// ============================================
// Update Location
// ============================================

const updateLocationSchema = z.object({
  name: z.string().describe('Full location resource name'),
  location: z.object({
    title: z.string().optional(),
    websiteUri: z.string().optional(),
    phoneNumbers: z.object({
      primaryPhone: z.string(),
      additionalPhones: z.array(z.string()).optional(),
    }).optional(),
  }).describe('Location fields to update'),
  updateMask: z.string().describe('Comma-separated list of fields to update'),
});

type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const gbpUpdateLocationTool: ToolDefinition<UpdateLocationInput, GBPLocation> = {
  name: 'gbp_update_location',
  description: 'Updates a GBP location\'s information',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: updateLocationSchema,

  async handler(input: UpdateLocationInput): Promise<GBPLocation> {
    log.info('Updating GBP location', { name: input.name });

    const locationsClient = getLocationsClient();
    const locationName = normalizeLocationName(input.name);

    const response = await executeGoogleApi('businessProfile', () =>
      locationsClient.patch({
        name: locationName,
        updateMask: input.updateMask,
        requestBody: input.location,
      }),
    );

    const loc = response.data as Record<string, unknown>;
    const phoneNumbers = loc.phoneNumbers as Record<string, unknown> | undefined;
    const categories = loc.categories as Record<string, unknown> | undefined;
    const storefrontAddress = loc.storefrontAddress as Record<string, unknown> | undefined;
    const latlng = loc.latlng as Record<string, number> | undefined;
    const primaryCat = categories?.primaryCategory as Record<string, unknown> | undefined;
    const additionalCats = categories?.additionalCategories as Array<Record<string, unknown>> | undefined;

    log.info('Updated GBP location', { name: input.name });

    return {
      name: String(loc.name || ''),
      title: String(loc.title || ''),
      storeCode: loc.storeCode ? String(loc.storeCode) : undefined,
      websiteUri: loc.websiteUri ? String(loc.websiteUri) : undefined,
      phoneNumbers: phoneNumbers ? {
        primaryPhone: String(phoneNumbers.primaryPhone || ''),
        additionalPhones: phoneNumbers.additionalPhones as string[] | undefined,
      } : undefined,
      categories: categories ? {
        primaryCategory: { displayName: String(primaryCat?.displayName || '') },
        additionalCategories: additionalCats?.map((c: Record<string, unknown>) => ({ displayName: String(c.displayName || '') })),
      } : undefined,
      address: {
        regionCode: String(storefrontAddress?.regionCode || ''),
        languageCode: String(storefrontAddress?.languageCode || ''),
        postalCode: String(storefrontAddress?.postalCode || ''),
        administrativeArea: String(storefrontAddress?.administrativeArea || ''),
        locality: String(storefrontAddress?.locality || ''),
        addressLines: (storefrontAddress?.addressLines as string[]) || [],
      },
      latlng: latlng ? {
        latitude: Number(latlng.latitude || 0),
        longitude: Number(latlng.longitude || 0),
      } : undefined,
    };
  },
};
