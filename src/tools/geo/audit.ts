/**
 * AI-search-friendly page audit — heuristic scoring for how extractable a
 * page is by LLM crawlers (ChatGPT, Perplexity, Google AI Overviews).
 *
 * Signals checked:
 *   - structured data (FAQ/HowTo/Article schemas → strong LLM extraction)
 *   - heading hierarchy (H1 + H2 sections)
 *   - canonical + meta description
 *   - open graph (preview rendering by AI clients)
 *   - text-to-HTML ratio
 *   - llms.txt at site root
 */

import { z } from 'zod';
import * as cheerio from 'cheerio';
import { fetchUrl } from '../base.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('geo-audit');

const schema = z.object({
  url: z.string().url().describe('Page URL to audit'),
});

type Input = z.infer<typeof schema>;

interface Check {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  weight: number;
}

interface Output {
  url: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  checks: Check[];
  recommendations: string[];
}

function grade(score: number): Output['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export const geoAiSearchAuditTool: ToolDefinition<Input, Output> = {
  name: 'geo_ai_search_friendly_audit',
  description:
    'Audits a page for AI search extractability: structured data, headings, canonical/meta, OpenGraph, text density, llms.txt. Returns scored checklist + recommendations.',
  category: ToolCategory.SEO,
  inputSchema: schema,

  async handler(input): Promise<Output> {
    log.info('Auditing for AI search', { url: input.url });

    const res = await fetchUrl(input.url);
    if (res.status !== 200) {
      return {
        url: input.url,
        score: 0,
        grade: 'F',
        checks: [],
        recommendations: [`Page returned HTTP ${res.status} — not crawlable.`],
      };
    }

    const $ = cheerio.load(res.data);
    const html = res.data;
    const textLength = $('body').text().replace(/\s+/g, ' ').trim().length;
    const htmlLength = html.length;
    const textRatio = htmlLength > 0 ? textLength / htmlLength : 0;

    const checks: Check[] = [];

    const h1Count = $('h1').length;
    checks.push({
      id: 'h1_exactly_one',
      label: 'Exactly one H1',
      passed: h1Count === 1,
      detail: `Found ${h1Count} H1 tag(s)`,
      weight: 10,
    });

    const h2Count = $('h2').length;
    checks.push({
      id: 'h2_sections',
      label: 'Has H2 sections (3+)',
      passed: h2Count >= 3,
      detail: `Found ${h2Count} H2 tag(s)`,
      weight: 10,
    });

    const metaDesc = $('meta[name="description"]').attr('content')?.trim() ?? '';
    checks.push({
      id: 'meta_description',
      label: 'Meta description present (50-160 chars)',
      passed: metaDesc.length >= 50 && metaDesc.length <= 160,
      detail: metaDesc ? `Length: ${metaDesc.length}` : 'Missing',
      weight: 8,
    });

    const canonical = $('link[rel="canonical"]').attr('href')?.trim() ?? '';
    checks.push({
      id: 'canonical',
      label: 'Canonical URL present',
      passed: !!canonical,
      detail: canonical || 'Missing',
      weight: 8,
    });

    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
    const ogDesc = $('meta[property="og:description"]').attr('content')?.trim() ?? '';
    checks.push({
      id: 'open_graph',
      label: 'OpenGraph tags (title + description)',
      passed: !!ogTitle && !!ogDesc,
      detail: ogTitle && ogDesc ? 'Both present' : `og:title=${!!ogTitle}, og:description=${!!ogDesc}`,
      weight: 6,
    });

    const ldJsonNodes = $('script[type="application/ld+json"]');
    const schemaTypes = new Set<string>();
    ldJsonNodes.each((_, el) => {
      try {
        const parsed = JSON.parse($(el).contents().text());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const t = item?.['@type'];
          if (typeof t === 'string') schemaTypes.add(t);
          else if (Array.isArray(t)) t.forEach((x: string) => schemaTypes.add(x));
        }
      } catch {
        /* skip bad JSON-LD */
      }
    });

    checks.push({
      id: 'structured_data',
      label: 'Structured data present',
      passed: schemaTypes.size > 0,
      detail: schemaTypes.size > 0 ? `Types: ${[...schemaTypes].join(', ')}` : 'No JSON-LD found',
      weight: 12,
    });

    const llmExtractable = ['FAQPage', 'HowTo', 'QAPage', 'Article', 'BlogPosting', 'Product'];
    const hasExtractable = [...schemaTypes].some((t) => llmExtractable.includes(t));
    checks.push({
      id: 'llm_extractable_schema',
      label: 'Has LLM-extractable schema (FAQ/HowTo/Article/Product)',
      passed: hasExtractable,
      detail: hasExtractable ? 'Yes' : 'Missing — FAQ/HowTo schemas get cited most by LLMs',
      weight: 10,
    });

    checks.push({
      id: 'text_ratio',
      label: 'Text-to-HTML ratio >= 15%',
      passed: textRatio >= 0.15,
      detail: `${Math.round(textRatio * 100)}% (${textLength} text chars / ${htmlLength} html chars)`,
      weight: 8,
    });

    checks.push({
      id: 'text_length',
      label: 'Body text >= 500 chars',
      passed: textLength >= 500,
      detail: `${textLength} chars`,
      weight: 6,
    });

    const lang = $('html').attr('lang');
    checks.push({
      id: 'html_lang',
      label: 'html[lang] attribute set',
      passed: !!lang,
      detail: lang ?? 'Missing',
      weight: 4,
    });

    let llmsTxtExists = false;
    try {
      const origin = new URL(input.url).origin;
      const r = await fetchUrl(`${origin}/llms.txt`);
      llmsTxtExists = r.status === 200;
    } catch {
      /* ignore */
    }
    checks.push({
      id: 'llms_txt',
      label: 'Site has /llms.txt',
      passed: llmsTxtExists,
      detail: llmsTxtExists ? 'Present' : 'Missing at site root',
      weight: 8,
    });

    const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
    const earned = checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
    const score = Math.round((earned / totalWeight) * 100);

    const recommendations = checks
      .filter((c) => !c.passed)
      .sort((a, b) => b.weight - a.weight)
      .map((c) => `[${c.weight}pts] ${c.label} — ${c.detail}`);

    return { url: input.url, score, grade: grade(score), checks, recommendations };
  },
};
