/**
 * reddit_draft_reply — generates a Reddit reply draft.
 *
 * Reddit is even more anti-marketing than HN. Self-promotion is bannable
 * on most subs; brand accounts get downvoted on sight. The prompt is
 * explicit. Output is plain Reddit markdown (limited subset).
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
} from '../social/shared.js';

const log = createServiceLogger('reddit-draft');

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

const redditDraftSchema = z.object({
  siteUrl: z.string(),
  subreddit: z.string().max(80).optional().describe('Without the r/ prefix (e.g. "SEO", "webdev")'),
  threadUrl: z.string().url().optional().describe('Full URL of the Reddit thread you\'re replying to'),
  threadContext: z.string().max(3000).optional().describe('Pasted excerpt: thread title + body, or parent comment text'),
  topic: z.string().min(2).optional(),
  sourceUrl: z.string().url().optional(),
  article: articleSchema.optional(),
  brandVoice: z.string().max(2000).optional(),
  niche: z.string().max(120).optional(),
  competitors: z.array(competitorSchema).max(10).optional(),
  language: z.enum(['en', 'es']).optional().describe('Most subs are English — default en'),
  additionalContext: z.string().max(2000).optional(),
  model: z.string().optional(),
});

type RedditDraftInput = z.infer<typeof redditDraftSchema>;

export interface RedditDraftOutput {
  body: string;
  charCount: number;
  subreddit: string | null;
  threadUrl: string | null;
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  /** Constant flag the dashboard reads to render a "review before posting" warning. */
  sensitivityNote: string;
}

const REDDIT_SENSITIVITY_NOTE =
  'Reddit es comunidad sensible — más estricta que HN. Verificá las reglas del subreddit (sidebar) antes de postear. Cero auto-promoción a menos que el sub lo permita explícitamente. Si tu cuenta es nueva o tiene karma bajo, postear desde una cuenta personal con historial real.';

function buildRedditPrompt(input: RedditDraftInput): { system: string; user: string } {
  const lang = input.language ?? 'en';
  const langName = lang === 'es' ? 'Spanish (es-CR)' : 'English';

  const systemParts = [
    `You are drafting a Reddit reply in ${langName}. Reddit downvotes anything that smells of marketing, brand voice, or self-promotion. Most subs ban it outright.`,
    '',
    '## Hard rules',
    '- NEVER link to or recommend the site you\'re associated with unless the question literally asks for it.',
    '- NEVER use "we", "our team", "as a company" framing — write as one individual.',
    '- NEVER start with "Great question!" / "This is something I\'ve been thinking about..." — too AI.',
    '- Use lowercase + casual punctuation where it reads natural. Reddit isn\'t LinkedIn.',
    '- Specific anecdote > general advice. Concrete numbers > vague claims.',
    '- If you disagree, say so directly. Hedging reads as weak on Reddit.',
    '- Acknowledge the OP\'s context. If they vented, validate the frustration first.',
    '',
    '## Length',
    '- Short reply (1-3 paragraphs) is usually right. Long walls of text get scrolled past.',
    '- A single sharp sentence is sometimes the best answer.',
    '',
    '## Reddit markdown (limited subset)',
    '- `code in backticks` works.',
    '- **bold** and *italic* work.',
    '- > quote for quoting parent comment.',
    '- Double newline for paragraph break. NO triple-pound headers (# ##), no nested formatting.',
    '',
    '## Response format',
    'Return strict JSON:',
    '```json',
    '{ "body": "your reply, plain Reddit markdown" }',
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
  ];
  if (input.subreddit) {
    userParts.push(`Subreddit: r/${input.subreddit.replace(/^r\//, '')}`);
  }
  if (input.threadUrl) {
    userParts.push(`Thread URL: ${input.threadUrl}`);
  }
  if (input.threadContext && input.threadContext.trim()) {
    userParts.push('', '## Thread context (what you\'re replying to)', input.threadContext.trim());
  }

  userParts.push(formatSourceForPrompt({
    topic: input.topic,
    sourceUrl: input.sourceUrl,
    article: input.article,
  }));

  if (input.additionalContext && input.additionalContext.trim()) {
    userParts.push('', '## Additional context', input.additionalContext.trim());
  }

  userParts.push('', 'Draft the reply now. JSON only.');

  return { system: systemParts.join('\n'), user: userParts.join('\n') };
}

export const redditDraftReplyTool: ToolDefinition<RedditDraftInput, RedditDraftOutput> = {
  name: 'reddit_draft_reply',
  description:
    'Generates a draft Reddit reply via the Anthropic SDK. Stateless. Prompt is explicit about Reddit\'s anti-marketing sensitivity — review before posting. Defaults to English; supports Spanish for Spanish-speaking subs.',
  category: ToolCategory.SEO,
  inputSchema: redditDraftSchema,

  async handler(input: RedditDraftInput): Promise<RedditDraftOutput> {
    // Thread context is the strongest source on Reddit; if absent, fall through
    // to the standard source check.
    if (!input.threadContext) {
      ensureSomeSource({ topic: input.topic, sourceUrl: input.sourceUrl, article: input.article });
    }

    const lang = input.language ?? 'en';
    const model = input.model ?? DEFAULT_SOCIAL_MODEL;
    const { system, user } = buildRedditPrompt(input);

    log.info('Drafting Reddit reply', {
      siteUrl: input.siteUrl,
      subreddit: input.subreddit ?? null,
      hasThreadContext: !!input.threadContext,
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
      throw MCPError.externalServiceError('anthropic', 'Reddit drafter returned no text content');
    }

    let parsed: { body?: string };
    try {
      parsed = extractJsonBlock(textBlock.text);
    } catch (err) {
      log.error('Reddit drafter produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'Reddit drafter returned malformed JSON');
    }

    if (!parsed.body || typeof parsed.body !== 'string') {
      throw MCPError.externalServiceError('anthropic', 'Reddit drafter returned empty body');
    }

    return {
      body: parsed.body,
      charCount: parsed.body.length,
      subreddit: input.subreddit ?? null,
      threadUrl: input.threadUrl ?? null,
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
      sensitivityNote: REDDIT_SENSITIVITY_NOTE,
    };
  },
};
