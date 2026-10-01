/**
 * Google Search Console - Sites tools
 */

import { z } from 'zod';
import { getSearchConsoleClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GSCSite } from '../../../types/google.js';

const log = createServiceLogger('gsc-sites');

// ============================================
// List Sites
// ============================================

const listSitesSchema = z.object({});

type ListSitesInput = z.infer<typeof listSitesSchema>;

interface ListSitesOutput {
  sites: GSCSite[];
}

export const gscListSitesTool: ToolDefinition<ListSitesInput, ListSitesOutput> = {
  name: 'gsc_list_sites',
  description: 'Lists all sites in Google Search Console accessible to the authenticated user',
  category: ToolCategory.GOOGLE,
  inputSchema: listSitesSchema,

  async handler(_input: ListSitesInput): Promise<ListSitesOutput> {
    log.info('Listing Search Console sites');

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.sites.list();

    const sites: GSCSite[] = (response.data.siteEntry || []).map((site) => ({
      siteUrl: site.siteUrl || '',
      permissionLevel: site.permissionLevel || '',
    }));

    log.info('Listed Search Console sites', { count: sites.length });

    return { sites };
  },
};

// ============================================
// Get Site
// ============================================

const getSiteSchema = z.object({
  siteUrl: z.string().describe('The site URL (e.g., https://example.com/ or sc-domain:example.com)'),
});

type GetSiteInput = z.infer<typeof getSiteSchema>;

export const gscGetSiteTool: ToolDefinition<GetSiteInput, GSCSite> = {
  name: 'gsc_get_site',
  description: 'Gets information about a specific site in Search Console',
  category: ToolCategory.GOOGLE,
  inputSchema: getSiteSchema,

  async handler(input: GetSiteInput): Promise<GSCSite> {
    log.info('Getting Search Console site', { siteUrl: input.siteUrl });

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.sites.get({
      siteUrl: input.siteUrl,
    });

    return {
      siteUrl: response.data.siteUrl || input.siteUrl,
      permissionLevel: response.data.permissionLevel || '',
    };
  },
};
