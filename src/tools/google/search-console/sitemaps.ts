/**
 * Google Search Console - Sitemaps tools
 */

import { z } from 'zod';
import { getSearchConsoleClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GSCSitemap } from '../../../types/google.js';

const log = createServiceLogger('gsc-sitemaps');

// ============================================
// List Sitemaps
// ============================================

const listSitemapsSchema = z.object({
  siteUrl: z.string().describe('Site URL (e.g., https://example.com/)'),
});

type ListSitemapsInput = z.infer<typeof listSitemapsSchema>;

interface ListSitemapsOutput {
  sitemaps: GSCSitemap[];
}

export const gscListSitemapsTool: ToolDefinition<ListSitemapsInput, ListSitemapsOutput> = {
  name: 'gsc_list_sitemaps',
  description: 'Lists all sitemaps submitted for a site in Search Console',
  category: ToolCategory.GOOGLE,
  inputSchema: listSitemapsSchema,

  async handler(input: ListSitemapsInput): Promise<ListSitemapsOutput> {
    log.info('Listing sitemaps', { siteUrl: input.siteUrl });

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.sitemaps.list({
      siteUrl: input.siteUrl,
    });

    const sitemaps: GSCSitemap[] = (response.data.sitemap || []).map((sm) => ({
      path: sm.path || '',
      lastSubmitted: sm.lastSubmitted || '',
      isPending: sm.isPending || false,
      isSitemapsIndex: sm.isSitemapsIndex || false,
      lastDownloaded: sm.lastDownloaded || undefined,
      warnings: sm.warnings ? Number(sm.warnings) : undefined,
      errors: sm.errors ? Number(sm.errors) : undefined,
      contents: sm.contents?.map((c) => ({
        type: c.type || '',
        submitted: c.submitted ? Number(c.submitted) : undefined,
        indexed: c.indexed ? Number(c.indexed) : undefined,
      })),
    }));

    log.info('Listed sitemaps', { count: sitemaps.length });

    return { sitemaps };
  },
};

// ============================================
// Get Sitemap
// ============================================

const getSitemapSchema = z.object({
  siteUrl: z.string().describe('Site URL'),
  feedpath: z.string().describe('Full URL of the sitemap'),
});

type GetSitemapInput = z.infer<typeof getSitemapSchema>;

export const gscGetSitemapTool: ToolDefinition<GetSitemapInput, GSCSitemap> = {
  name: 'gsc_get_sitemap',
  description: 'Gets detailed information about a specific sitemap',
  category: ToolCategory.GOOGLE,
  inputSchema: getSitemapSchema,

  async handler(input: GetSitemapInput): Promise<GSCSitemap> {
    log.info('Getting sitemap', input);

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.sitemaps.get({
      siteUrl: input.siteUrl,
      feedpath: input.feedpath,
    });

    const sm = response.data;

    return {
      path: sm.path || '',
      lastSubmitted: sm.lastSubmitted || '',
      isPending: sm.isPending || false,
      isSitemapsIndex: sm.isSitemapsIndex || false,
      lastDownloaded: sm.lastDownloaded || undefined,
      warnings: sm.warnings ? Number(sm.warnings) : undefined,
      errors: sm.errors ? Number(sm.errors) : undefined,
      contents: sm.contents?.map((c) => ({
        type: c.type || '',
        submitted: c.submitted ? Number(c.submitted) : undefined,
        indexed: c.indexed ? Number(c.indexed) : undefined,
      })),
    };
  },
};

// ============================================
// Submit Sitemap
// ============================================

const submitSitemapSchema = z.object({
  siteUrl: z.string().describe('Site URL'),
  feedpath: z.string().describe('Full URL of the sitemap to submit'),
});

type SubmitSitemapInput = z.infer<typeof submitSitemapSchema>;

interface SubmitSitemapOutput {
  success: boolean;
  feedpath: string;
}

export const gscSubmitSitemapTool: ToolDefinition<SubmitSitemapInput, SubmitSitemapOutput> = {
  name: 'gsc_submit_sitemap',
  description: 'Submits a sitemap for crawling in Search Console',
  category: ToolCategory.GOOGLE,
  inputSchema: submitSitemapSchema,

  async handler(input: SubmitSitemapInput): Promise<SubmitSitemapOutput> {
    log.info('Submitting sitemap', input);

    const searchConsole = await getSearchConsoleClient();

    await searchConsole.sitemaps.submit({
      siteUrl: input.siteUrl,
      feedpath: input.feedpath,
    });

    log.info('Sitemap submitted', { feedpath: input.feedpath });

    return {
      success: true,
      feedpath: input.feedpath,
    };
  },
};

// ============================================
// Delete Sitemap
// ============================================

const deleteSitemapSchema = z.object({
  siteUrl: z.string().describe('Site URL'),
  feedpath: z.string().describe('Full URL of the sitemap to delete'),
});

type DeleteSitemapInput = z.infer<typeof deleteSitemapSchema>;

interface DeleteSitemapOutput {
  success: boolean;
  feedpath: string;
}

export const gscDeleteSitemapTool: ToolDefinition<DeleteSitemapInput, DeleteSitemapOutput> = {
  name: 'gsc_delete_sitemap',
  description: 'Deletes a sitemap from Search Console',
  category: ToolCategory.GOOGLE,
  inputSchema: deleteSitemapSchema,

  async handler(input: DeleteSitemapInput): Promise<DeleteSitemapOutput> {
    log.info('Deleting sitemap', input);

    const searchConsole = await getSearchConsoleClient();

    await searchConsole.sitemaps.delete({
      siteUrl: input.siteUrl,
      feedpath: input.feedpath,
    });

    log.info('Sitemap deleted', { feedpath: input.feedpath });

    return {
      success: true,
      feedpath: input.feedpath,
    };
  },
};
