/**
 * Sitemap fix utilities:
 *   - fix_resubmit_sitemap: submit (or re-submit) sitemap to GSC with verification
 *   - fix_clean_sitemap: fetch sitemap, probe each URL, return cleaned XML
 *     (does NOT write to user's server — caller deploys the output)
 */

import { z } from 'zod';
import * as cheerio from 'cheerio';
import { fetchUrl } from '../base.js';
import { executeGoogleApi } from '../google/api-wrapper.js';
import { getSearchConsoleClient } from '../google/search-console/clients.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('fix-sitemap');

// ============================================
// fix_resubmit_sitemap
// ============================================

const resubmitSchema = z.object({
  siteUrl: z.string().describe('GSC site URL'),
  sitemapUrl: z.string().url().describe('Sitemap absolute URL'),
});

type ResubmitInput = z.infer<typeof resubmitSchema>;

interface ResubmitOutput {
  siteUrl: string;
  sitemapUrl: string;
  submitted: boolean;
  postSubmissionStatus?: {
    lastSubmitted?: string;
    isPending?: boolean;
    isSitemapsIndex?: boolean;
    errors?: number;
    warnings?: number;
    contents?: { type?: string; submitted?: string; indexed?: string }[];
  };
}

export const fixResubmitSitemapTool: ToolDefinition<ResubmitInput, ResubmitOutput> = {
  name: 'fix_resubmit_sitemap',
  description:
    'Submits a sitemap to Google Search Console and fetches its post-submission status (errors/warnings/indexed counts) for verification.',
  category: ToolCategory.SEARCH_CONSOLE,
  inputSchema: resubmitSchema,

  async handler(input): Promise<ResubmitOutput> {
    log.info('Resubmitting sitemap', input);
    const sc = getSearchConsoleClient();

    await executeGoogleApi('searchConsole', () =>
      sc.sitemaps.submit({ siteUrl: input.siteUrl, feedpath: input.sitemapUrl })
    );

    let postStatus: ResubmitOutput['postSubmissionStatus'];
    try {
      const status = await executeGoogleApi('searchConsole', () =>
        sc.sitemaps.get({ siteUrl: input.siteUrl, feedpath: input.sitemapUrl })
      );
      postStatus = {
        lastSubmitted: status.data.lastSubmitted ?? undefined,
        isPending: status.data.isPending ?? undefined,
        isSitemapsIndex: status.data.isSitemapsIndex ?? undefined,
        errors: typeof status.data.errors === 'string' ? parseInt(status.data.errors, 10) : status.data.errors ?? undefined,
        warnings:
          typeof status.data.warnings === 'string' ? parseInt(status.data.warnings, 10) : status.data.warnings ?? undefined,
        contents: status.data.contents?.map((c) => ({
          type: c.type ?? undefined,
          submitted: c.submitted != null ? String(c.submitted) : undefined,
          indexed: c.indexed != null ? String(c.indexed) : undefined,
        })),
      };
    } catch (e) {
      log.warn('Could not fetch post-submission status', { error: (e as Error).message });
    }

    return { siteUrl: input.siteUrl, sitemapUrl: input.sitemapUrl, submitted: true, postSubmissionStatus: postStatus };
  },
};

// ============================================
// fix_clean_sitemap
// ============================================

const cleanSchema = z.object({
  sitemapUrl: z.string().url().describe('Sitemap to fetch and clean'),
  removeStatuses: z.array(z.number()).optional().describe('HTTP statuses to remove (default: 404, 410, 500, 502, 503)'),
  followRedirects: z.boolean().optional().describe('If true, replace 301/302 URLs with final destination (default false)'),
  concurrency: z.number().min(1).max(20).optional().describe('Probe concurrency (default 8)'),
});

type CleanInput = z.infer<typeof cleanSchema>;

interface UrlStatus {
  url: string;
  status: number;
  finalUrl?: string;
  action: 'kept' | 'removed' | 'replaced';
  reason?: string;
}

interface CleanOutput {
  sitemapUrl: string;
  totalUrls: number;
  kept: number;
  removed: number;
  replaced: number;
  details: UrlStatus[];
  cleanedXml: string;
}

async function probe(url: string): Promise<{ status: number; finalUrl?: string }> {
  try {
    const res = await fetchUrl(url);
    return { status: res.status };
  } catch {
    return { status: 0 };
  }
}

export const fixCleanSitemapTool: ToolDefinition<CleanInput, CleanOutput> = {
  name: 'fix_clean_sitemap',
  description:
    'Fetches sitemap, probes each URL, removes 404/410/5xx entries and (optionally) rewrites redirects to their final destination. Returns details + cleaned XML. Caller deploys the output.',
  category: ToolCategory.SEO,
  inputSchema: cleanSchema,

  async handler(input): Promise<CleanOutput> {
    const removeStatuses = new Set(input.removeStatuses ?? [404, 410, 500, 502, 503]);
    const concurrency = input.concurrency ?? 8;
    log.info('Cleaning sitemap', { sitemapUrl: input.sitemapUrl });

    const res = await fetchUrl(input.sitemapUrl);
    if (res.status !== 200) {
      throw new Error(`Sitemap fetch failed: HTTP ${res.status}`);
    }
    const $ = cheerio.load(res.data, { xmlMode: true });
    const urls: string[] = [];
    $('url > loc').each((_, el) => {
      const u = $(el).text().trim();
      if (u) urls.push(u);
    });

    const details: UrlStatus[] = [];
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const probed = await Promise.all(batch.map((u) => probe(u).then((p) => ({ url: u, ...p }))));
      for (const p of probed) {
        if (removeStatuses.has(p.status)) {
          details.push({ url: p.url, status: p.status, action: 'removed', reason: `HTTP ${p.status}` });
        } else if (input.followRedirects && [301, 302, 307, 308].includes(p.status) && p.finalUrl && p.finalUrl !== p.url) {
          details.push({
            url: p.url,
            status: p.status,
            finalUrl: p.finalUrl,
            action: 'replaced',
            reason: `Redirect → ${p.finalUrl}`,
          });
        } else {
          details.push({ url: p.url, status: p.status, action: 'kept' });
        }
      }
    }

    const keptUrls = details
      .filter((d) => d.action !== 'removed')
      .map((d) => (d.action === 'replaced' && d.finalUrl ? d.finalUrl : d.url));

    const cleanedXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      keptUrls.map((u) => `  <url>\n    <loc>${u}</loc>\n  </url>`).join('\n') +
      `\n</urlset>\n`;

    return {
      sitemapUrl: input.sitemapUrl,
      totalUrls: urls.length,
      kept: details.filter((d) => d.action === 'kept').length,
      removed: details.filter((d) => d.action === 'removed').length,
      replaced: details.filter((d) => d.action === 'replaced').length,
      details,
      cleanedXml,
    };
  },
};
