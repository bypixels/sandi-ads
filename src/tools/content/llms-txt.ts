/**
 * llms.txt generator — produces a well-formed llms.txt from sitemap +
 * GSC top pages, so LLMs can discover your most-important URLs.
 *
 * Spec: https://llmstxt.org/
 */

import { z } from 'zod';
import * as cheerio from 'cheerio';
import { fetchUrl } from '../base.js';
import { executeGoogleApi } from '../google/api-wrapper.js';
import { getSearchConsoleClient } from '../google/search-console/clients.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('content-llms-txt');

const schema = z.object({
  siteUrl: z.string().describe('GSC site URL (for pulling top pages by traffic)'),
  baseUrl: z.string().url().describe('Canonical site origin (e.g. https://example.com)'),
  sitemapUrl: z.string().url().optional().describe('Sitemap URL (default: {baseUrl}/sitemap.xml)'),
  title: z.string().optional().describe('Site title (default: derived from homepage <title>)'),
  description: z.string().optional().describe('Short site description (default: derived from homepage <meta description>)'),
  maxPages: z.number().min(5).max(200).optional().describe('Max URLs to include (default 50)'),
});

type Input = z.infer<typeof schema>;

interface Output {
  llmsTxt: string;
  urlsIncluded: number;
  source: { sitemap: number; gsc: number };
  warnings: string[];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchSitemapUrls(url: string): Promise<string[]> {
  try {
    const res = await fetchUrl(url);
    if (res.status !== 200) return [];
    const $ = cheerio.load(res.data, { xmlMode: true });
    const urls: string[] = [];
    $('url > loc').each((_, el) => {
      const u = $(el).text().trim();
      if (u) urls.push(u);
    });
    if (urls.length === 0) {
      $('sitemap > loc').each((_, el) => {
        const u = $(el).text().trim();
        if (u) urls.push(u);
      });
    }
    return urls;
  } catch {
    return [];
  }
}

async function fetchHomepageMeta(url: string): Promise<{ title: string; description: string }> {
  try {
    const res = await fetchUrl(url);
    if (res.status !== 200) return { title: '', description: '' };
    const $ = cheerio.load(res.data);
    return {
      title: $('title').first().text().trim(),
      description: $('meta[name="description"]').attr('content')?.trim() ?? '',
    };
  } catch {
    return { title: '', description: '' };
  }
}

async function fetchPageTitle(url: string): Promise<string> {
  try {
    const res = await fetchUrl(url);
    if (res.status !== 200) return '';
    const $ = cheerio.load(res.data);
    return $('title').first().text().trim() || $('h1').first().text().trim();
  } catch {
    return '';
  }
}

export const contentGenerateLlmsTxtTool: ToolDefinition<Input, Output> = {
  name: 'content_generate_llms_txt',
  description:
    'Generates a well-formed llms.txt for your site: pulls top URLs from GSC (by traffic) + sitemap, fetches titles, and outputs the markdown spec ready to host at /llms.txt.',
  category: ToolCategory.SEO,
  inputSchema: schema,

  async handler(input): Promise<Output> {
    const warnings: string[] = [];
    const max = input.maxPages ?? 50;

    log.info('Generating llms.txt', { baseUrl: input.baseUrl });

    const sitemapUrl = input.sitemapUrl ?? `${input.baseUrl.replace(/\/$/, '')}/sitemap.xml`;
    const [meta, sitemapUrls, gscPages] = await Promise.all([
      fetchHomepageMeta(input.baseUrl),
      fetchSitemapUrls(sitemapUrl),
      executeGoogleApi('searchConsole', async () => {
        try {
          const sc = getSearchConsoleClient();
          const resp = await sc.searchanalytics.query({
            siteUrl: input.siteUrl,
            requestBody: {
              startDate: daysAgo(90),
              endDate: daysAgo(1),
              dimensions: ['page'],
              rowLimit: max,
            },
          });
          return (resp.data.rows ?? []).map((r) => ({ page: r.keys?.[0] ?? '', clicks: r.clicks ?? 0 }));
        } catch (e) {
          warnings.push(`GSC unavailable: ${(e as Error).message}`);
          return [] as { page: string; clicks: number }[];
        }
      }),
    ]);

    if (sitemapUrls.length === 0) warnings.push(`Sitemap empty or unreachable at ${sitemapUrl}`);

    const seen = new Set<string>();
    const ranked: { url: string; rank: number }[] = [];

    gscPages
      .filter((p) => p.page.startsWith(input.baseUrl))
      .sort((a, b) => b.clicks - a.clicks)
      .forEach((p, i) => {
        if (!seen.has(p.page)) {
          seen.add(p.page);
          ranked.push({ url: p.page, rank: i });
        }
      });

    sitemapUrls
      .filter((u) => u.startsWith(input.baseUrl))
      .forEach((u, i) => {
        if (!seen.has(u)) {
          seen.add(u);
          ranked.push({ url: u, rank: gscPages.length + i });
        }
      });

    const top = ranked.slice(0, max);

    const titles = await Promise.all(top.map(async (t) => ({ url: t.url, title: await fetchPageTitle(t.url) })));

    const title = input.title ?? meta.title ?? new URL(input.baseUrl).hostname;
    const description = input.description ?? meta.description ?? '';

    const lines: string[] = [`# ${title}`, ''];
    if (description) {
      lines.push(`> ${description}`, '');
    }

    const docs = titles.filter((t) => /\/(docs|guides?|getting-started)\//.test(t.url));
    const blog = titles.filter((t) => /\/(blog|articles?|posts?)\//.test(t.url));
    const product = titles.filter((t) => /\/(features?|pricing|product|integrations?)\//.test(t.url));
    const other = titles.filter((t) => !docs.includes(t) && !blog.includes(t) && !product.includes(t));

    const writeSection = (heading: string, items: typeof titles) => {
      if (items.length === 0) return;
      lines.push(`## ${heading}`, '');
      for (const it of items) {
        const label = it.title || new URL(it.url).pathname;
        lines.push(`- [${label}](${it.url})`);
      }
      lines.push('');
    };

    writeSection('Product', product);
    writeSection('Documentation', docs);
    writeSection('Blog', blog);
    writeSection('Other', other);

    const llmsTxt = lines.join('\n').trimEnd() + '\n';

    return {
      llmsTxt,
      urlsIncluded: top.length,
      source: { sitemap: sitemapUrls.length, gsc: gscPages.length },
      warnings,
    };
  },
};
