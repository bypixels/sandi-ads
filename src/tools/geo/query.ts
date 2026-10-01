/**
 * GEO — Generative Engine Optimization.
 *
 * geo_query_ai_search: ask an AI search engine (Perplexity) a question
 * and capture its answer + cited sources. The atomic primitive the other
 * GEO tools build on.
 *
 * Requires PERPLEXITY_API_KEY in env. Perplexity is the only provider
 * supported in MVP — its Sonar models include real-time web grounding
 * with structured citations, which is exactly what we need.
 */

import { z } from 'zod';
import axios from 'axios';
import { createServiceLogger } from '../../utils/logger.js';
import { MCPError, ErrorCode } from '../../types/errors.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('geo-query');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';

const schema = z.object({
  prompt: z.string().min(3).describe('User question to ask the AI search engine'),
  model: z
    .enum(['sonar', 'sonar-pro', 'sonar-reasoning'])
    .optional()
    .describe('Perplexity model (default: sonar)'),
  systemPrompt: z.string().optional().describe('Optional system prompt'),
  temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (default 0.2)'),
});

type Input = z.infer<typeof schema>;

export interface AiSearchCitation {
  url: string;
  title?: string;
  snippet?: string;
}

export interface AiSearchResult {
  provider: 'perplexity';
  model: string;
  answer: string;
  citations: AiSearchCitation[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export async function queryPerplexity(input: Input): Promise<AiSearchResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new MCPError({
      code: ErrorCode.AUTH_NOT_CONFIGURED,
      message: 'PERPLEXITY_API_KEY not set. Get a key at https://docs.perplexity.ai',
      retryable: false,
      service: 'perplexity',
    });
  }

  const model = input.model ?? 'sonar';
  const messages: { role: string; content: string }[] = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.prompt });

  const resp = await axios.post(
    PERPLEXITY_API,
    {
      model,
      messages,
      temperature: input.temperature ?? 0.2,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
      validateStatus: () => true,
    }
  );

  if (resp.status >= 400) {
    const msg = resp.data?.error?.message || resp.data?.detail || `HTTP ${resp.status}`;
    throw MCPError.externalServiceError('perplexity', msg);
  }

  const choice = resp.data?.choices?.[0];
  const answer = choice?.message?.content ?? '';
  const citationUrls: string[] = resp.data?.citations ?? [];
  const searchResults = resp.data?.search_results ?? [];

  const citations: AiSearchCitation[] = citationUrls.length
    ? citationUrls.map((u, i) => ({
        url: u,
        title: searchResults[i]?.title,
        snippet: searchResults[i]?.snippet,
      }))
    : searchResults.map((s: { url?: string; title?: string; snippet?: string }) => ({
        url: s.url ?? '',
        title: s.title,
        snippet: s.snippet,
      }));

  return {
    provider: 'perplexity',
    model,
    answer,
    citations,
    usage: {
      promptTokens: resp.data?.usage?.prompt_tokens,
      completionTokens: resp.data?.usage?.completion_tokens,
    },
  };
}

export const geoQueryAiSearchTool: ToolDefinition<Input, AiSearchResult> = {
  name: 'geo_query_ai_search',
  description:
    'Queries Perplexity AI search and returns the answer + cited source URLs. Requires PERPLEXITY_API_KEY env var. Foundation for brand-visibility and share-of-voice tools.',
  category: ToolCategory.SEO,
  inputSchema: schema,

  async handler(input): Promise<AiSearchResult> {
    log.info('Querying AI search', { prompt: input.prompt.slice(0, 80), model: input.model });
    return queryPerplexity(input);
  },
};
