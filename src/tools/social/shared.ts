/**
 * Shared helpers for the social drafters (X, LinkedIn, HN).
 *
 * All three call the Anthropic SDK with platform-specific prompts and parse
 * a JSON response. The Anthropic init + JSON extraction + brand-context
 * formatting are identical across them — kept here so prompt tuning + model
 * changes happen in one place per concern.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MCPError } from '../../types/errors.js';

export const DEFAULT_SOCIAL_MODEL = process.env.SOCIAL_DRAFTER_MODEL || 'claude-sonnet-4-6';

export function buildAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw MCPError.authError('ANTHROPIC_API_KEY no configurado. Agregá tu key en Settings.');
  }
  return new Anthropic({ apiKey });
}

/**
 * Pulls a JSON object out of the model's text response. The prompt always
 * asks for raw JSON, but the model occasionally wraps it in a ```json fence —
 * tolerate both. Throws a friendly error when the body isn't parseable.
 */
export function extractJsonBlock<T = unknown>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body) as T;
}

export interface BrandContext {
  /** Free-form brand voice statement (tone, words to use/avoid). */
  brandVoice?: string;
  /** Industry/niche label, e.g. "legal-tech", "B2B SaaS". */
  niche?: string;
  /** Known competitors — used to differentiate without naming them. */
  competitors?: Array<{ name: string; url?: string; notes?: string }>;
}

/**
 * Formats brand context as a markdown block to append to system prompts.
 * Returns empty string when no signals are present so callers can append
 * unconditionally.
 */
export function formatBrandContext(ctx: BrandContext): string {
  const lines: string[] = [];
  if (ctx.brandVoice && ctx.brandVoice.trim()) {
    lines.push('', '## Brand voice (mandatorio — aplicalo en cada palabra)', ctx.brandVoice.trim());
  }
  if (ctx.niche && ctx.niche.trim()) {
    lines.push('', '## Nicho del sitio', ctx.niche.trim());
  }
  if (ctx.competitors && ctx.competitors.length > 0) {
    lines.push('', '## Competidores conocidos (diferenciá sin nombrarlos)');
    for (const c of ctx.competitors) {
      lines.push(`- ${c.name}${c.url ? ` (${c.url})` : ''}${c.notes ? ` — ${c.notes}` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Describes the source material for a social draft. At least one of the
 * three forms must be provided; the platform-specific tool decides how to
 * use them.
 */
export interface SocialSource {
  /** Free-form topic the user typed (most common case from the UI). */
  topic?: string;
  /** A URL to reference — the model may or may not have crawled it. */
  sourceUrl?: string;
  /** Source title + body (typically copied from an approved article draft). */
  article?: {
    title: string;
    summary?: string;
    bodyMarkdown: string;
    slug?: string;
  };
}

export function formatSourceForPrompt(source: SocialSource): string {
  const lines: string[] = [];
  if (source.topic && source.topic.trim()) {
    lines.push(`Tema: ${source.topic.trim()}`);
  }
  if (source.sourceUrl && source.sourceUrl.trim()) {
    lines.push(`URL de referencia: ${source.sourceUrl.trim()}`);
  }
  if (source.article) {
    lines.push('', `## Artículo fuente`, `**${source.article.title}**`);
    if (source.article.summary) lines.push('', `Resumen: ${source.article.summary}`);
    lines.push('', '### Cuerpo del artículo (Markdown)', source.article.bodyMarkdown);
  }
  return lines.join('\n');
}

export function ensureSomeSource(source: SocialSource): void {
  if (!source.topic && !source.sourceUrl && !source.article) {
    throw MCPError.validationError(
      'At least one of `topic`, `sourceUrl`, or `article` is required.',
    );
  }
}
