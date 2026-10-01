/**
 * content_write_article — long-form article generator informed by the site's
 * brand voice, niche, and (optionally) GSC-derived brief.
 *
 * Stateless tool: returns the generated article. The dashboard's writer-run
 * endpoint orchestrates draft persistence so the tool stays usable from any
 * MCP client (not just the dashboard).
 *
 * Uses the Anthropic SDK directly — same model the chat agent uses. The
 * caller may pass a `brief` (e.g. produced by content_brief_from_keyword) or
 * just a `keyword`; when only a keyword is given, the writer drafts from
 * keyword + context without GSC-derived structure.
 */

import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';
import { MCPError } from '../../types/errors.js';

const log = createServiceLogger('content-writer');

const competitorSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  notes: z.string().optional(),
});

const briefSchema = z.object({
  targetKeyword: z.string(),
  semanticCluster: z
    .array(z.object({ query: z.string(), impressions: z.number().optional(), position: z.number().optional() }))
    .default([]),
  recommendation: z
    .object({
      action: z.string().optional(),
      reason: z.string().optional(),
      suggestedMinWords: z.number().optional(),
      targetH2Count: z.number().optional(),
    })
    .optional(),
});

const writeArticleSchema = z.object({
  siteUrl: z.string().describe('Primary site URL (used for context, not for API calls)'),
  keyword: z.string().min(2).describe('Target keyword/topic for the article').optional(),
  brief: briefSchema.optional().describe('Structured brief from content_brief_from_keyword. If absent, the writer drafts from keyword + context only.'),
  brandVoice: z.string().max(2000).optional().describe('Brand voice description to apply throughout the draft'),
  niche: z.string().max(120).optional().describe('Site niche/industry for context'),
  competitors: z.array(competitorSchema).max(10).optional().describe('Known competitors to differentiate against'),
  targetWordCount: z.number().int().min(300).max(5000).optional().describe('Approximate target length (default 1200)'),
  language: z.enum(['es', 'en', 'pt']).optional().describe('Output language (default es)'),
  additionalContext: z.string().max(2000).optional().describe('Anything else the writer should know'),
  model: z.string().optional().describe('Override Anthropic model (default claude-sonnet-4-6)'),
});

type WriteArticleInput = z.infer<typeof writeArticleSchema>;

export interface WriteArticleOutput {
  title: string;
  metaDescription: string;
  suggestedSlug: string;
  bodyMarkdown: string;
  outline: string[];
  wordCount: number;
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

const DEFAULT_MODEL = process.env.WRITER_MODEL || 'claude-sonnet-4-6';
const DEFAULT_WORD_COUNT = 1200;

function buildPrompt(input: WriteArticleInput): { system: string; user: string } {
  const lang = input.language ?? 'es';
  const wordCount = input.targetWordCount ?? DEFAULT_WORD_COUNT;
  const keyword = input.brief?.targetKeyword ?? input.keyword ?? '';

  const langName = lang === 'es' ? 'español (es-CR)' : lang === 'pt' ? 'português' : 'English';

  const systemParts = [
    `Sos un escritor especializado en SEO que produce artículos de blog en ${langName}.`,
    '',
    'Tu output debe ser:',
    '- Editorialmente impecable (no relleno, no "fluff", no clichés AI tipo "in today\'s world").',
    '- Estructurado: H1 + intro corta + H2/H3 con cuerpo concreto + conclusión accionable.',
    '- Optimizado para search intent del keyword target sin keyword-stuffing.',
    '- Markdown puro: # H1, ## H2, ### H3, listas, **bold** donde aporte, [enlaces internos sugeridos](URL) cuando sean relevantes.',
    '',
    '## Formato de respuesta',
    'Devolvé JSON estricto con esta forma exacta:',
    '```json',
    '{',
    '  "title": "...",',
    '  "metaDescription": "máx 160 chars",',
    '  "suggestedSlug": "kebab-case-version",',
    '  "outline": ["H1 title", "H2 1", "H2 2", "..."],',
    '  "bodyMarkdown": "# Title\\n\\n..."',
    '}',
    '```',
    'NADA fuera del JSON. Sin prefijo "Aquí está", sin code fence afuera del JSON.',
  ];

  if (input.brandVoice && input.brandVoice.trim()) {
    systemParts.push('', '## Brand voice (mandatorio)', input.brandVoice.trim());
  }

  if (input.niche && input.niche.trim()) {
    systemParts.push('', `## Nicho del sitio`, input.niche.trim());
  }

  if (input.competitors && input.competitors.length > 0) {
    systemParts.push('', '## Competidores conocidos (diferenciá contra ellos sin nombrarlos)');
    for (const c of input.competitors) {
      systemParts.push(`- ${c.name}${c.url ? ` (${c.url})` : ''}${c.notes ? ` — ${c.notes}` : ''}`);
    }
  }

  const userParts = [
    `Sitio: ${input.siteUrl}`,
    `Keyword target: ${keyword}`,
    `Word count objetivo: ~${wordCount}`,
  ];

  if (input.brief) {
    if (input.brief.semanticCluster.length > 0) {
      userParts.push('', 'Queries semánticamente relacionadas (de GSC, alta demanda real):');
      for (const q of input.brief.semanticCluster.slice(0, 15)) {
        const meta = [
          q.impressions != null ? `${q.impressions} impressions` : null,
          q.position != null ? `pos ${q.position.toFixed(1)}` : null,
        ].filter(Boolean).join(', ');
        userParts.push(`- "${q.query}"${meta ? ` (${meta})` : ''}`);
      }
      userParts.push('', 'Cubrí estos sub-topics si encajan en el flow narrativo. No los listes mecánicamente.');
    }
    if (input.brief.recommendation) {
      const r = input.brief.recommendation;
      if (r.suggestedMinWords) userParts.push('', `Mínimo sugerido: ${r.suggestedMinWords} palabras.`);
      if (r.targetH2Count) userParts.push(`Apuntá a ~${r.targetH2Count} secciones H2.`);
      if (r.reason) userParts.push(`Contexto: ${r.reason}`);
    }
  }

  if (input.additionalContext && input.additionalContext.trim()) {
    userParts.push('', '## Contexto adicional', input.additionalContext.trim());
  }

  userParts.push('', 'Escribí el artículo ahora. Devolvé solo el JSON.');

  return { system: systemParts.join('\n'), user: userParts.join('\n') };
}

function extractJsonBlock(text: string): unknown {
  // The model is told to return raw JSON, but be defensive: strip ```json fences if present.
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body);
}

function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter(Boolean).length;
}

export const contentWriteArticleTool: ToolDefinition<WriteArticleInput, WriteArticleOutput> = {
  name: 'content_write_article',
  description:
    'Generates a full-length article (markdown) using the Anthropic SDK, applying brand voice, niche, competitor context, and (optionally) a GSC-derived semantic brief. Returns title, meta, slug, outline and body. Stateless — caller is responsible for persisting.',
  category: ToolCategory.SEO,
  inputSchema: writeArticleSchema,

  async handler(input: WriteArticleInput): Promise<WriteArticleOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw MCPError.authError('ANTHROPIC_API_KEY no configurado. Agregá tu key en Settings.');
    }
    if (!input.keyword && !input.brief?.targetKeyword) {
      throw MCPError.validationError('Either `keyword` or `brief.targetKeyword` is required.');
    }

    const lang = input.language ?? 'es';
    const targetWords = input.targetWordCount ?? DEFAULT_WORD_COUNT;
    const model = input.model ?? DEFAULT_MODEL;
    const { system, user } = buildPrompt(input);

    log.info('Writing article', {
      siteUrl: input.siteUrl,
      keyword: input.keyword ?? input.brief?.targetKeyword,
      hasBrief: !!input.brief,
      targetWords,
      model,
    });

    const client = new Anthropic({ apiKey });
    // Conservative: ~3-4 tokens per word; cap at 8000 output tokens.
    const maxTokens = Math.min(8000, Math.ceil(targetWords * 5));

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw MCPError.externalServiceError('anthropic', 'Writer model returned no text content');
    }

    let parsed: { title?: string; metaDescription?: string; suggestedSlug?: string; outline?: string[]; bodyMarkdown?: string };
    try {
      parsed = extractJsonBlock(textBlock.text) as typeof parsed;
    } catch (err) {
      log.error('Writer produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'Writer model returned malformed JSON');
    }

    if (!parsed.title || !parsed.bodyMarkdown) {
      throw MCPError.externalServiceError('anthropic', 'Writer model output missing title or bodyMarkdown');
    }

    return {
      title: parsed.title,
      metaDescription: (parsed.metaDescription ?? '').slice(0, 160),
      suggestedSlug: parsed.suggestedSlug ?? '',
      bodyMarkdown: parsed.bodyMarkdown,
      outline: Array.isArray(parsed.outline) ? parsed.outline : [],
      wordCount: wordCount(parsed.bodyMarkdown),
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
    };
  },
};
