/**
 * social_draft_x — generates a draft tweet or thread for X.
 *
 * Output is structured (kind + tweets[]) so the dashboard's draft viewer
 * can render each tweet with its own char counter. Stateless: the dashboard
 * persists; the caller never publishes.
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

const log = createServiceLogger('social-x');

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

const xDraftSchema = z.object({
  siteUrl: z.string(),
  topic: z.string().min(2).optional(),
  sourceUrl: z.string().url().optional(),
  article: articleSchema.optional(),
  format: z.enum(['single', 'thread', 'auto']).optional().describe('Default auto — the model picks based on source length'),
  brandVoice: z.string().max(2000).optional(),
  niche: z.string().max(120).optional(),
  competitors: z.array(competitorSchema).max(10).optional(),
  language: z.enum(['es', 'en', 'pt']).optional(),
  additionalContext: z.string().max(2000).optional(),
  model: z.string().optional(),
});

type XDraftInput = z.infer<typeof xDraftSchema>;

export interface XDraftOutput {
  kind: 'single' | 'thread';
  tweets: string[];
  /** Sum of character counts across tweets (helpful for UI feedback). */
  totalChars: number;
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

function buildXPrompt(input: XDraftInput): { system: string; user: string } {
  const lang = input.language ?? 'es';
  const langName = lang === 'es' ? 'español (es-CR)' : lang === 'pt' ? 'português' : 'English';
  const format = input.format ?? 'auto';

  const systemParts = [
    `Sos un experto en X/Twitter que escribe ${langName} natural — voz humana, ritmo de scroll, sin sonar a marketing.`,
    '',
    '## Reglas de plataforma',
    '- Single tweet: máx 280 chars (CON espacios y emojis).',
    '- Thread: entre 2 y 8 tweets, cada uno ≤ 280 chars, el primero abre con hook fuerte.',
    '- Cero hashtags spam. Máximo 1-2 hashtags al final si aportan; mejor cero.',
    '- Cero emojis decorativos. Permitidos cuando reemplazan una palabra entera (→, ↑, etc).',
    '- Cero "in this thread we explore..." ni metacomentarios.',
    '- Citas concretas, datos, ángulos contraintuitivos > generalidades.',
    '',
    `## Formato a producir: ${format === 'auto' ? 'el modelo decide single vs thread según la riqueza del contenido' : format}`,
    '',
    '## Formato de respuesta',
    'Devolvé JSON estricto con esta forma EXACTA:',
    '```json',
    '{',
    '  "kind": "single" | "thread",',
    '  "tweets": ["tweet 1", "tweet 2", ...]',
    '}',
    '```',
    'NADA fuera del JSON. Sin prefijos como "Acá está", sin code fence afuera del JSON.',
    'Validación: cada string en "tweets" DEBE ser ≤ 280 chars.',
  ];

  systemParts.push(formatBrandContext({
    brandVoice: input.brandVoice,
    niche: input.niche,
    competitors: input.competitors,
  }));

  const userParts = [
    `Sitio: ${input.siteUrl}`,
    formatSourceForPrompt({
      topic: input.topic,
      sourceUrl: input.sourceUrl,
      article: input.article,
    }),
  ];

  if (input.additionalContext && input.additionalContext.trim()) {
    userParts.push('', '## Contexto adicional', input.additionalContext.trim());
  }

  userParts.push('', 'Generá el draft ahora. Solo JSON.');

  return { system: systemParts.join('\n'), user: userParts.join('\n') };
}

export const socialDraftXTool: ToolDefinition<XDraftInput, XDraftOutput> = {
  name: 'social_draft_x',
  description:
    'Generates a draft tweet or thread for X using the Anthropic SDK. Applies brand voice + niche + competitor context. Source can be a topic, a URL, or an article body. Returns { kind, tweets[] }. Stateless.',
  category: ToolCategory.SEO,
  inputSchema: xDraftSchema,

  async handler(input: XDraftInput): Promise<XDraftOutput> {
    ensureSomeSource({ topic: input.topic, sourceUrl: input.sourceUrl, article: input.article });

    const lang = input.language ?? 'es';
    const model = input.model ?? DEFAULT_SOCIAL_MODEL;
    const { system, user } = buildXPrompt(input);

    log.info('Drafting X post', {
      siteUrl: input.siteUrl,
      format: input.format ?? 'auto',
      source: input.article ? 'article' : input.sourceUrl ? 'url' : 'topic',
      model,
    });

    const client = buildAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw MCPError.externalServiceError('anthropic', 'X drafter returned no text content');
    }

    let parsed: { kind?: string; tweets?: unknown };
    try {
      parsed = extractJsonBlock(textBlock.text);
    } catch (err) {
      log.error('X drafter produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'X drafter returned malformed JSON');
    }

    const tweets = Array.isArray(parsed.tweets) ? parsed.tweets.filter((t): t is string => typeof t === 'string') : [];
    if (tweets.length === 0) {
      throw MCPError.externalServiceError('anthropic', 'X drafter returned no tweets');
    }
    // Hard-truncate to be safe; X enforces 280 server-side anyway. We don't
    // silently drop — we cap with an ellipsis so the human sees it in review.
    const capped = tweets.map((t) => (t.length > 280 ? t.slice(0, 277) + '…' : t));
    const kind = parsed.kind === 'thread' || capped.length > 1 ? 'thread' : 'single';

    return {
      kind: kind as 'single' | 'thread',
      tweets: capped,
      totalChars: capped.reduce((sum, t) => sum + t.length, 0),
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
    };
  },
};
