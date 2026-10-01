/**
 * GEO brand visibility — does your brand get mentioned/cited by AI search?
 *
 * - geo_check_brand_visibility: single brand across N prompts
 * - geo_competitor_share_of_voice: brand + competitors across N prompts
 */

import { z } from 'zod';
import { queryPerplexity, type AiSearchCitation } from './query.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('geo-visibility');

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function extractDomain(input: string): string {
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname.replace(/^www\./, '');
  } catch {
    return input.toLowerCase();
  }
}

function checkBrandPresence(
  answer: string,
  citations: AiSearchCitation[],
  brandTerms: string[],
  brandDomain: string | undefined
): { mentionedInAnswer: boolean; citedInSources: boolean; citedUrls: string[] } {
  const normAnswer = normalizeForMatch(answer);
  const mentionedInAnswer = brandTerms.some((t) => normAnswer.includes(normalizeForMatch(t)));

  const domain = brandDomain ? extractDomain(brandDomain) : undefined;
  const citedUrls = citations
    .filter((c) => {
      if (!c.url) return false;
      if (domain) {
        try {
          const host = new URL(c.url).hostname.replace(/^www\./, '');
          if (host === domain || host.endsWith(`.${domain}`)) return true;
        } catch {
          /* ignore bad URL */
        }
      }
      const normTitle = normalizeForMatch((c.title ?? '') + ' ' + (c.snippet ?? '') + ' ' + c.url);
      return brandTerms.some((t) => normTitle.includes(normalizeForMatch(t)));
    })
    .map((c) => c.url);

  return { mentionedInAnswer, citedInSources: citedUrls.length > 0, citedUrls };
}

// ============================================
// geo_check_brand_visibility
// ============================================

const brandVisSchema = z.object({
  brand: z.string().min(2).describe('Brand or product name'),
  brandDomain: z.string().optional().describe('Brand domain (helps detect citations even if name varies)'),
  prompts: z.array(z.string().min(3)).min(1).max(20).describe('Prompts to test (max 20)'),
  brandAliases: z.array(z.string()).optional().describe('Alternate spellings/products'),
  model: z.enum(['sonar', 'sonar-pro', 'sonar-reasoning']).optional(),
});

type BrandVisInput = z.infer<typeof brandVisSchema>;

interface PromptResult {
  prompt: string;
  mentionedInAnswer: boolean;
  citedInSources: boolean;
  citedUrls: string[];
  answerPreview: string;
}

interface BrandVisOutput {
  brand: string;
  totalPrompts: number;
  summary: {
    mentionRate: number;
    citationRate: number;
    fullVisibilityRate: number;
  };
  results: PromptResult[];
}

export const geoCheckBrandVisibilityTool: ToolDefinition<BrandVisInput, BrandVisOutput> = {
  name: 'geo_check_brand_visibility',
  description:
    'For each prompt, queries AI search and checks if the brand is mentioned in the answer and/or cited in sources. Returns per-prompt results + aggregate visibility rates.',
  category: ToolCategory.SEO,
  inputSchema: brandVisSchema,

  async handler(input): Promise<BrandVisOutput> {
    log.info('Checking brand visibility', { brand: input.brand, prompts: input.prompts.length });

    const brandTerms = [input.brand, ...(input.brandAliases ?? [])];

    const results: PromptResult[] = [];
    for (const prompt of input.prompts) {
      try {
        const res = await queryPerplexity({ prompt, model: input.model });
        const presence = checkBrandPresence(res.answer, res.citations, brandTerms, input.brandDomain);
        results.push({
          prompt,
          mentionedInAnswer: presence.mentionedInAnswer,
          citedInSources: presence.citedInSources,
          citedUrls: presence.citedUrls,
          answerPreview: res.answer.slice(0, 300),
        });
      } catch (e) {
        results.push({
          prompt,
          mentionedInAnswer: false,
          citedInSources: false,
          citedUrls: [],
          answerPreview: `[ERROR] ${(e as Error).message}`,
        });
      }
    }

    const mentions = results.filter((r) => r.mentionedInAnswer).length;
    const citations = results.filter((r) => r.citedInSources).length;
    const full = results.filter((r) => r.mentionedInAnswer && r.citedInSources).length;
    const n = results.length || 1;

    return {
      brand: input.brand,
      totalPrompts: results.length,
      summary: {
        mentionRate: Math.round((mentions / n) * 1000) / 10,
        citationRate: Math.round((citations / n) * 1000) / 10,
        fullVisibilityRate: Math.round((full / n) * 1000) / 10,
      },
      results,
    };
  },
};

// ============================================
// geo_competitor_share_of_voice
// ============================================

const sovSchema = z.object({
  brands: z
    .array(z.object({ name: z.string(), domain: z.string().optional(), aliases: z.array(z.string()).optional() }))
    .min(2)
    .max(8)
    .describe('Your brand + competitors (2-8 total)'),
  prompts: z.array(z.string().min(3)).min(1).max(15).describe('Prompts to test'),
  model: z.enum(['sonar', 'sonar-pro', 'sonar-reasoning']).optional(),
});

type SovInput = z.infer<typeof sovSchema>;

interface SovPromptRow {
  prompt: string;
  scores: Record<string, { mentioned: boolean; cited: boolean; citedUrls: string[] }>;
  answerPreview: string;
}

interface SovOutput {
  totalPrompts: number;
  brands: string[];
  matrix: SovPromptRow[];
  summary: Record<string, { mentionRate: number; citationRate: number; firstMentionRate: number }>;
}

export const geoCompetitorShareOfVoiceTool: ToolDefinition<SovInput, SovOutput> = {
  name: 'geo_competitor_share_of_voice',
  description:
    'Compares your brand vs competitors in AI search results. For each prompt, scores who is mentioned, cited, and mentioned first. Returns matrix + aggregate share of voice.',
  category: ToolCategory.SEO,
  inputSchema: sovSchema,

  async handler(input): Promise<SovOutput> {
    log.info('SOV analysis', { brands: input.brands.length, prompts: input.prompts.length });

    const matrix: SovPromptRow[] = [];
    const firstMentionCounts: Record<string, number> = {};
    for (const b of input.brands) firstMentionCounts[b.name] = 0;

    for (const prompt of input.prompts) {
      const row: SovPromptRow = { prompt, scores: {}, answerPreview: '' };
      try {
        const res = await queryPerplexity({ prompt, model: input.model });
        row.answerPreview = res.answer.slice(0, 300);

        const normAnswer = normalizeForMatch(res.answer);
        let firstMentionAt = Infinity;
        let firstBrand: string | null = null;

        for (const brand of input.brands) {
          const brandTerms = [brand.name, ...(brand.aliases ?? [])];
          const presence = checkBrandPresence(res.answer, res.citations, brandTerms, brand.domain);
          row.scores[brand.name] = {
            mentioned: presence.mentionedInAnswer,
            cited: presence.citedInSources,
            citedUrls: presence.citedUrls,
          };

          if (presence.mentionedInAnswer) {
            const positions = brandTerms.map((t) => normAnswer.indexOf(normalizeForMatch(t))).filter((p) => p >= 0);
            const earliest = positions.length ? Math.min(...positions) : Infinity;
            if (earliest < firstMentionAt) {
              firstMentionAt = earliest;
              firstBrand = brand.name;
            }
          }
        }
        if (firstBrand) firstMentionCounts[firstBrand]++;
      } catch (e) {
        row.answerPreview = `[ERROR] ${(e as Error).message}`;
        for (const b of input.brands) {
          row.scores[b.name] = { mentioned: false, cited: false, citedUrls: [] };
        }
      }
      matrix.push(row);
    }

    const summary: SovOutput['summary'] = {};
    const n = matrix.length || 1;
    for (const brand of input.brands) {
      const mentions = matrix.filter((r) => r.scores[brand.name]?.mentioned).length;
      const citations = matrix.filter((r) => r.scores[brand.name]?.cited).length;
      summary[brand.name] = {
        mentionRate: Math.round((mentions / n) * 1000) / 10,
        citationRate: Math.round((citations / n) * 1000) / 10,
        firstMentionRate: Math.round((firstMentionCounts[brand.name] / n) * 1000) / 10,
      };
    }

    return { totalPrompts: matrix.length, brands: input.brands.map((b) => b.name), matrix, summary };
  },
};
