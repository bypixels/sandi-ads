/**
 * Propose meta description fixes for a page.
 *
 * We can't write to the user's CMS directly (no integration in MVP), so
 * this returns structured proposals — the consumer (Claude agent, dashboard,
 * or external automation) applies them via WordPress REST, Webflow API,
 * Cloudflare Worker, etc.
 */

import { z } from 'zod';
import * as cheerio from 'cheerio';
import { fetchUrl } from '../base.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('fix-meta');

const schema = z.object({
  urls: z.array(z.string().url()).min(1).max(50).describe('Pages to audit and propose fixes for'),
  minLength: z.number().min(50).max(200).optional().describe('Min acceptable length (default 110)'),
  maxLength: z.number().min(100).max(200).optional().describe('Max acceptable length (default 160)'),
});

type Input = z.infer<typeof schema>;

interface Proposal {
  url: string;
  currentMeta: string | null;
  currentLength: number;
  issue: 'missing' | 'too_short' | 'too_long' | 'ok';
  proposed: string | null;
  proposedLength: number;
  rationale: string;
}

interface Output {
  total: number;
  needFix: number;
  proposals: Proposal[];
}

function summarize(text: string, maxLen: number, minLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;

  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const s of sentences) {
    if ((out + ' ' + s).trim().length > maxLen) break;
    out = (out + ' ' + s).trim();
  }
  if (out.length < minLen) {
    out = cleaned.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  }
  return out;
}

function extractBodyText($: cheerio.CheerioAPI): string {
  const firstP = $('main p, article p, .content p, p').first().text().trim();
  if (firstP.length > 50) return firstP;

  const h1 = $('h1').first().text().trim();
  const followingPara = $('h1').first().nextAll('p').first().text().trim();
  if (followingPara) return `${h1}. ${followingPara}`;

  return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 500);
}

export const fixProposeMetaDescriptionsTool: ToolDefinition<Input, Output> = {
  name: 'fix_propose_meta_descriptions',
  description:
    'Audits meta descriptions across pages and proposes fixes (extracted from page content) for missing/too-short/too-long ones. Returns structured proposals — does NOT write to your CMS. Pair with approval-gate before applying.',
  category: ToolCategory.SEO,
  inputSchema: schema,

  async handler(input): Promise<Output> {
    const minLen = input.minLength ?? 110;
    const maxLen = input.maxLength ?? 160;

    log.info('Proposing meta fixes', { urls: input.urls.length });

    const proposals: Proposal[] = await Promise.all(
      input.urls.map(async (url) => {
        try {
          const res = await fetchUrl(url);
          if (res.status !== 200) {
            return {
              url,
              currentMeta: null,
              currentLength: 0,
              issue: 'missing' as const,
              proposed: null,
              proposedLength: 0,
              rationale: `HTTP ${res.status} — page unreachable`,
            };
          }
          const $ = cheerio.load(res.data);
          const current = $('meta[name="description"]').attr('content')?.trim() ?? '';

          let issue: Proposal['issue'];
          if (!current) issue = 'missing';
          else if (current.length < minLen) issue = 'too_short';
          else if (current.length > maxLen) issue = 'too_long';
          else issue = 'ok';

          if (issue === 'ok') {
            return {
              url,
              currentMeta: current,
              currentLength: current.length,
              issue,
              proposed: null,
              proposedLength: 0,
              rationale: 'Already within target range',
            };
          }

          const source = issue === 'too_long' ? current : extractBodyText($);
          const proposed = summarize(source, maxLen, minLen);

          const rationale =
            issue === 'missing'
              ? 'Generated from first paragraph / H1 context'
              : issue === 'too_short'
                ? `Current ${current.length} chars < ${minLen} min — extended from page content`
                : `Current ${current.length} chars > ${maxLen} max — trimmed`;

          return {
            url,
            currentMeta: current || null,
            currentLength: current.length,
            issue,
            proposed,
            proposedLength: proposed.length,
            rationale,
          };
        } catch (e) {
          return {
            url,
            currentMeta: null,
            currentLength: 0,
            issue: 'missing' as const,
            proposed: null,
            proposedLength: 0,
            rationale: `Fetch failed: ${(e as Error).message}`,
          };
        }
      })
    );

    const needFix = proposals.filter((p) => p.issue !== 'ok' && p.proposed).length;

    return { total: proposals.length, needFix, proposals };
  },
};
