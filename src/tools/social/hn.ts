/**
 * social_draft_hn — generates a Hacker News comment draft.
 *
 * HN is more sensitive than X/LinkedIn — comments that smell like marketing
 * get downvoted and reported fast. The prompt is explicit about this. Use
 * cases: replying to a thread that's discussing your space, surfacing a
 * relevant data point, or sharing a contrarian observation.
 *
 * Output: { body }. UI shows a "review carefully before posting" banner.
 */

import { z } from 'zod';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';
import { MCPError } from '../../types/errors.js';
import {
  DEFAULT_SOCIAL_MODEL,
  buildAnthropicClient,
  extractJsonBlock,
  formatBrandContext,
  formatSourceForPrompt,
  ensureSomeSource,
} from './shared.js';

const log = createServiceLogger('social-hn');

const competitorSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  notes: z.string().optional(),
});

const articleSchema = z.object({
  title: z.string(),
  summary: z.string().optional(),
  bodyMarkdown: z.string(),
  slug: z.string().optional(),
});

const hnSchema = z.object({
  siteUrl: z.string(),
  topic: z.string().min(2).optional(),
  sourceUrl: z.string().url().optional(),
  /** The HN thread URL or title — gives the model context about the discussion. */
  threadContext: z.string().max(2000).optional()
    .describe('Pasted excerpt from the HN thread or the parent comment being replied to'),
  article: articleSchema.optional(),
  brandVoice: z.string().max(2000).optional(),
  niche: z.string().max(120).optional(),
  competitors: z.array(competitorSchema).max(10).optional(),
  language: z.enum(['en', 'es']).optional().describe('HN is mostly English — default en'),
  additionalContext: z.string().max(2000).optional(),
  model: z.string().optional(),
});

type HNInput = z.infer<typeof hnSchema>;

export interface HNOutput {
  body: string;
  charCount: number;
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  /** Constant flag the dashboard reads to render a "review before posting" warning. */
  sensitivityNote: string;
}

function buildHnPrompt(input: HNInput): { system: string; user: string } {
  const lang = input.language ?? 'en';
  const langName = lang === 'es' ? 'Spanish (es-CR)' : 'English';

  const systemParts = [
    `You are drafting a Hacker News comment in ${langName}. HN is a community of technical people who downvote anything that reads like marketing, spin, or shilling.`,
    '',
    '## Hard rules',
    '- Never recommend your own product/site unless directly asked, and even then disclose the affiliation.',
    '- No "as someone who built X..." brag openers.',
    '- No "we" or "our company" framing — write as an individual sharing an observation.',
    '- Specific > general. Concrete numbers, code snippets, or named failure modes beat any vague claim.',
    '- Acknowledge counterpoints. If a sibling comment makes a good point, name it.',
    '- 2-4 paragraphs typical. A single sharp paragraph is often better than a long one.',
    '- Markdown is mostly stripped on HN — use plain text. Code in `backticks`, link as `https://...` raw.',
    '',
    '## What gets upvoted on HN',
    '- A specific data point that contradicts conventional wisdom in the thread.',
    '- A first-hand "this happened to me, here\'s what I learned" without self-promotion.',
    '- A precise correction with a citation/link.',
    '- A simple worked example that clarifies an abstract claim.',
    '',
    '## Format de respuesta',
    'Return strict JSON with this exact shape:',
    '```json',
    '{ "body": "your comment text here, plain prose" }',
    '```',
    'NOTHING outside the JSON.',
  ];

  systemParts.push(formatBrandContext({
    brandVoice: input.brandVoice,
    niche: input.niche,
    competitors: input.competitors,
  }));

  const userParts = [
    `Site (do NOT promote): ${input.siteUrl}`,
    formatSourceForPrompt({
      topic: input.topic,
      sourceUrl: input.sourceUrl,
      article: input.article,
    }),
  ];

  if (input.threadContext && input.threadContext.trim()) {
    userParts.push('', '## HN thread context (what you\'re replying to)', input.threadContext.trim());
  }

  if (input.additionalContext && input.additionalContext.trim()) {
    userParts.push('', '## Additional context', input.additionalContext.trim());
  }

  userParts.push('', 'Draft the comment now. JSON only.');

  return { system: systemParts.join('\n'), user: userParts.join('\n') };
}

const HN_SENSITIVITY_NOTE =
  'Revisá manualmente antes de postear. HN castiga el lenguaje promocional — si parece marketing, lo van a flaggear. Editá hasta que suene como vos respondiendo a un colega, no como una marca.';

export const socialDraftHnTool: ToolDefinition<HNInput, HNOutput> = {
  name: 'social_draft_hn',
  description:
    'Generates a Hacker News comment draft. Stateless. Prompt is explicit about HN\'s anti-marketing sensitivity — review carefully before posting. Defaults to English.',
  category: ToolCategory.SEO,
  inputSchema: hnSchema,

  async handler(input: HNInput): Promise<HNOutput> {
    ensureSomeSource({ topic: input.topic, sourceUrl: input.sourceUrl, article: input.article });

    const lang = input.language ?? 'en';
    const model = input.model ?? DEFAULT_SOCIAL_MODEL;
    const { system, user } = buildHnPrompt(input);

    log.info('Drafting HN comment', {
      siteUrl: input.siteUrl,
      hasThreadContext: !!input.threadContext,
      source: input.article ? 'article' : input.sourceUrl ? 'url' : 'topic',
      model,
    });

    const client = buildAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw MCPError.externalServiceError('anthropic', 'HN drafter returned no text content');
    }

    let parsed: { body?: string };
    try {
      parsed = extractJsonBlock(textBlock.text);
    } catch (err) {
      log.error('HN drafter produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'HN drafter returned malformed JSON');
    }

    if (!parsed.body || typeof parsed.body !== 'string') {
      throw MCPError.externalServiceError('anthropic', 'HN drafter returned empty body');
    }

    return {
      body: parsed.body,
      charCount: parsed.body.length,
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
      sensitivityNote: HN_SENSITIVITY_NOTE,
    };
  },
};
