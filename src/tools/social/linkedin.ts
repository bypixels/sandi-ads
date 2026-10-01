/**
 * social_draft_linkedin — generates a LinkedIn post draft.
 *
 * Output: { body, hashtags[] }. Length sweet spot is 1300-2200 chars
 * (LinkedIn's algorithm rewards mid-length posts; very short ones look thin,
 * very long ones get cut at the "see more" fold).
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

const log = createServiceLogger('social-linkedin');

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

const linkedInSchema = z.object({
  siteUrl: z.string(),
  topic: z.string().min(2).optional(),
  sourceUrl: z.string().url().optional(),
  article: articleSchema.optional(),
  angle: z.enum(['story', 'insight', 'announcement', 'how-to']).optional()
    .describe('Default insight — the model picks the matching narrative arc'),
  brandVoice: z.string().max(2000).optional(),
  niche: z.string().max(120).optional(),
  competitors: z.array(competitorSchema).max(10).optional(),
  language: z.enum(['es', 'en', 'pt']).optional(),
  additionalContext: z.string().max(2000).optional(),
  model: z.string().optional(),
});

type LinkedInInput = z.infer<typeof linkedInSchema>;

export interface LinkedInOutput {
  body: string;
  hashtags: string[];
  charCount: number;
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

function buildLinkedInPrompt(input: LinkedInInput): { system: string; user: string } {
  const lang = input.language ?? 'es';
  const langName = lang === 'es' ? 'español (es-CR)' : lang === 'pt' ? 'português' : 'English';
  const angle = input.angle ?? 'insight';

  const angleGuidance: Record<string, string> = {
    story: 'Narrativa personal en primera persona. Anécdota concreta → giro → lección. Sin clichés tipo "y eso me enseñó que..."',
    insight: 'Observación contraintuitiva o dato sorprendente del trabajo real. Cero teoría académica.',
    announcement: 'Algo concreto que vos / tu equipo hicieron, lanzaron o aprendieron. Específico, datado, accionable.',
    'how-to': 'Pasos numerados que el lector puede aplicar mañana. Sin "tips" genéricos.',
  };

  const systemParts = [
    `Sos un escritor experto en LinkedIn que produce posts en ${langName}.`,
    '',
    '## Reglas de plataforma',
    '- Sweet spot 1300-2200 chars (no muy corto, no muy largo).',
    '- Primer renglón = hook fuerte (es lo único visible antes del "see more").',
    '- Saltos de línea simples; LinkedIn renderiza markdown muy limitado — usá ** para énfasis solo si se ve bien.',
    '- 3-5 hashtags al final, relevantes y específicos (no #marketing #SEO #growth genéricos).',
    '- Cero "siento decirte esto pero…" / "few people are talking about…" / "agree?" tipo bait.',
    '- Cero emojis decorativos. Tolerable 1-2 si reemplazan palabras.',
    '',
    `## Ángulo narrativo: ${angle}`,
    angleGuidance[angle],
    '',
    '## Formato de respuesta',
    'Devolvé JSON estricto con esta forma exacta:',
    '```json',
    '{',
    '  "body": "primer línea hook\\n\\ndesarrollo...",',
    '  "hashtags": ["#tag1", "#tag2"]',
    '}',
    '```',
    'El "body" NO incluye los hashtags (van separados). NADA fuera del JSON.',
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

export const socialDraftLinkedInTool: ToolDefinition<LinkedInInput, LinkedInOutput> = {
  name: 'social_draft_linkedin',
  description:
    'Generates a draft LinkedIn post using the Anthropic SDK. Applies brand voice + niche + competitor context. Source can be a topic, URL or article. Returns { body, hashtags[] }. Stateless.',
  category: ToolCategory.SEO,
  inputSchema: linkedInSchema,

  async handler(input: LinkedInInput): Promise<LinkedInOutput> {
    ensureSomeSource({ topic: input.topic, sourceUrl: input.sourceUrl, article: input.article });

    const lang = input.language ?? 'es';
    const model = input.model ?? DEFAULT_SOCIAL_MODEL;
    const { system, user } = buildLinkedInPrompt(input);

    log.info('Drafting LinkedIn post', {
      siteUrl: input.siteUrl,
      angle: input.angle ?? 'insight',
      source: input.article ? 'article' : input.sourceUrl ? 'url' : 'topic',
      model,
    });

    const client = buildAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 2500,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw MCPError.externalServiceError('anthropic', 'LinkedIn drafter returned no text content');
    }

    let parsed: { body?: string; hashtags?: unknown };
    try {
      parsed = extractJsonBlock(textBlock.text);
    } catch (err) {
      log.error('LinkedIn drafter produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'LinkedIn drafter returned malformed JSON');
    }

    if (!parsed.body || typeof parsed.body !== 'string') {
      throw MCPError.externalServiceError('anthropic', 'LinkedIn drafter returned empty body');
    }
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags
          .filter((h): h is string => typeof h === 'string')
          .map((h) => (h.startsWith('#') ? h : `#${h}`))
          .slice(0, 5)
      : [];

    return {
      body: parsed.body,
      hashtags,
      charCount: parsed.body.length,
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
    };
  },
};
