/**
 * video_draft_brief — generates a UGC-style video brief.
 *
 * Output is a structured "recipe" a human creator (or an AI video model)
 * can execute: hook + main + CTA scripts, shot list with timestamps,
 * on-screen text, voiceover instructions, mood + thumbnail ideas.
 *
 * Stateless. The dashboard's `video` agent runner persists as a draft
 * (type `video_brief`). Actual video rendering is a separate tool
 * (`video_render_clip`) the user can invoke on an approved brief once a
 * provider (Runway / Pika / Replicate) is configured.
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
} from '../social/shared.js';

const log = createServiceLogger('video-brief');

const competitorSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  notes: z.string().optional(),
});

const videoBriefSchema = z.object({
  siteUrl: z.string(),
  topic: z.string().min(2).max(300).describe('Topic / angle for the video'),
  /** Aspect-ratio + platform hint. */
  format: z.enum(['reel', 'short', 'square', 'horizontal']).optional().default('reel'),
  /** Target duration in seconds (15-60 typical). */
  durationSec: z.number().int().min(8).max(180).optional().default(30),
  /** Style hint — affects mood, pace, visual treatment. */
  style: z.enum(['conversational', 'energetic', 'educational', 'narrative', 'product_demo']).optional()
    .default('conversational'),
  brandVoice: z.string().max(2000).optional(),
  niche: z.string().max(120).optional(),
  competitors: z.array(competitorSchema).max(10).optional(),
  language: z.enum(['es', 'en', 'pt']).optional(),
  additionalContext: z.string().max(2000).optional(),
  model: z.string().optional(),
});

type VideoBriefInput = z.infer<typeof videoBriefSchema>;

export interface ShotListItem {
  /** Timestamp window in the clip, e.g. "0-3s" or "12-18s". */
  timestamp: string;
  /** What's on screen / what's happening. */
  description: string;
  /** Type of visual content. */
  visualType: 'talking_head' | 'b_roll' | 'screen_recording' | 'text_overlay' | 'product_shot' | 'mixed';
  /** Optional production notes (lighting, framing, music cue). */
  notes?: string;
}

export interface OnScreenTextItem {
  timestamp: string;
  text: string;
}

export interface VideoBriefOutput {
  title: string;
  topic: string;
  format: 'reel' | 'short' | 'square' | 'horizontal';
  /** Display aspect ratio (derived from format, included for UI). */
  aspectRatio: string;
  durationSec: number;
  /** 0-3s hook script — the only thing that stops the scroll. */
  hookScript: string;
  /** 3s to (durationSec - 5s) — main content. */
  mainScript: string;
  /** Last ~5s — call to action. */
  ctaScript: string;
  shotList: ShotListItem[];
  onScreenText: OnScreenTextItem[];
  /** Tone, pace, accent, energy level for the voiceover (human or AI). */
  voiceoverInstructions: string;
  /** Mood + visual style notes for the editor / video model. */
  moodAndStyle: string;
  /** 2-4 thumbnail concepts described in plain language. */
  thumbnailIdeas: string[];
  /** Hashtags for the post caption (no #, just words). */
  hashtagsForCaption: string[];
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

const ASPECT_BY_FORMAT: Record<VideoBriefInput['format'] & string, string> = {
  reel: '9:16',
  short: '9:16',
  square: '1:1',
  horizontal: '16:9',
};

function buildPrompt(input: VideoBriefInput): { system: string; user: string } {
  const lang = input.language ?? 'es';
  const langName = lang === 'es' ? 'español (es-CR)' : lang === 'pt' ? 'português' : 'English';
  const format = input.format ?? 'reel';
  const aspect = ASPECT_BY_FORMAT[format];
  const duration = input.durationSec ?? 30;
  const style = input.style ?? 'conversational';

  const styleGuide: Record<string, string> = {
    conversational: 'Hablás directo a cámara como si le contaras algo a un amigo. Tono casual, ritmo natural, pausas humanas.',
    energetic: 'Alto contraste, cortes rápidos cada 2-3s, energía. Funciona para hooks fuertes en feeds saturados.',
    educational: 'Estructura de "aprendé X en Y segundos". Claridad sobre estilo. Pizarrón / screen recording / diagramas.',
    narrative: 'Mini-historia con setup → tensión → resolución. La mejor para retención emocional.',
    product_demo: 'Manos sobre el producto. Antes/después. Specs visibles. Cero relleno.',
  };

  const systemParts = [
    `Sos un strategist de UGC video que produce briefs en ${langName} para creadores (humanos o modelos AI). Tus briefs son ejecutables: cada timestamp tiene un shot concreto.`,
    '',
    `## Formato a producir`,
    `- Plataforma: ${format} (aspect ratio ${aspect})`,
    `- Duración target: ${duration}s`,
    `- Estilo: ${style} — ${styleGuide[style]}`,
    '',
    '## Reglas',
    '- Hook en los primeros 3s O perdés a la audiencia. El hookScript tiene que parar el scroll, no introducir.',
    '- Cero "in this video we will..." / "today I want to talk about...". El video YA empezó.',
    '- shotList con timestamps reales (0-3s, 3-7s, etc.) que sumen al duration target. No te pases ni te quedes corto.',
    '- onScreenText: solo cuando aporta. Cero subtítulos completos del voiceover (eso lo hace el editor).',
    '- Si recomendás música, especificá tipo/mood (no canciones específicas — copyright).',
    '- thumbnailIdeas: 2-4 conceptos visuales DISTINTOS. No variaciones del mismo.',
    '',
    '## Formato de respuesta',
    'Devolvé JSON estricto con esta forma EXACTA:',
    '```json',
    '{',
    '  "title": "headline del video",',
    '  "hookScript": "0-3s",',
    '  "mainScript": "3s a ' + (duration - 5) + 's",',
    '  "ctaScript": "últimos 5s",',
    '  "shotList": [{"timestamp": "0-3s", "description": "...", "visualType": "talking_head", "notes": "..."}],',
    '  "onScreenText": [{"timestamp": "5-8s", "text": "..."}],',
    '  "voiceoverInstructions": "...",',
    '  "moodAndStyle": "...",',
    '  "thumbnailIdeas": ["concepto 1", "concepto 2"],',
    '  "hashtagsForCaption": ["tag1", "tag2"]',
    '}',
    '```',
    'NADA fuera del JSON.',
  ];

  systemParts.push(formatBrandContext({
    brandVoice: input.brandVoice,
    niche: input.niche,
    competitors: input.competitors,
  }));

  const userParts = [
    `Sitio: ${input.siteUrl}`,
    `Tema: ${input.topic}`,
    `Duración: ${duration}s · Formato: ${format} (${aspect}) · Estilo: ${style}`,
  ];

  if (input.additionalContext && input.additionalContext.trim()) {
    userParts.push('', '## Contexto adicional', input.additionalContext.trim());
  }

  userParts.push('', 'Generá el brief ahora. Solo JSON.');

  return { system: systemParts.join('\n'), user: userParts.join('\n') };
}

export const videoDraftBriefTool: ToolDefinition<VideoBriefInput, VideoBriefOutput> = {
  name: 'video_draft_brief',
  description:
    'Generates a UGC-style video brief: hook + main + CTA scripts, shot list with timestamps, on-screen text, voiceover + mood + thumbnail ideas. Stateless — the dashboard persists as a draft. Video rendering is a separate, optional step (video_render_clip).',
  category: ToolCategory.SEO,
  inputSchema: videoBriefSchema,

  async handler(input: VideoBriefInput): Promise<VideoBriefOutput> {
    const lang = input.language ?? 'es';
    const format = input.format ?? 'reel';
    const aspect = ASPECT_BY_FORMAT[format];
    const duration = input.durationSec ?? 30;
    const model = input.model ?? DEFAULT_SOCIAL_MODEL;
    const { system, user } = buildPrompt(input);

    log.info('Drafting video brief', {
      siteUrl: input.siteUrl,
      topic: input.topic,
      format,
      duration,
      style: input.style ?? 'conversational',
      model,
    });

    const client = buildAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw MCPError.externalServiceError('anthropic', 'Video brief tool returned no text content');
    }

    let parsed: Partial<Omit<VideoBriefOutput, 'topic' | 'format' | 'aspectRatio' | 'durationSec' | 'language' | 'model' | 'tokensInput' | 'tokensOutput'>>;
    try {
      parsed = extractJsonBlock(textBlock.text);
    } catch (err) {
      log.error('Video brief tool produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'Video brief tool returned malformed JSON');
    }

    if (!parsed.title || !parsed.hookScript || !parsed.mainScript) {
      throw MCPError.externalServiceError('anthropic', 'Video brief missing title/hook/main fields');
    }

    return {
      title: parsed.title,
      topic: input.topic,
      format,
      aspectRatio: aspect,
      durationSec: duration,
      hookScript: parsed.hookScript,
      mainScript: parsed.mainScript,
      ctaScript: parsed.ctaScript ?? '',
      shotList: Array.isArray(parsed.shotList) ? parsed.shotList : [],
      onScreenText: Array.isArray(parsed.onScreenText) ? parsed.onScreenText : [],
      voiceoverInstructions: parsed.voiceoverInstructions ?? '',
      moodAndStyle: parsed.moodAndStyle ?? '',
      thumbnailIdeas: Array.isArray(parsed.thumbnailIdeas) ? parsed.thumbnailIdeas : [],
      hashtagsForCaption: Array.isArray(parsed.hashtagsForCaption) ? parsed.hashtagsForCaption : [],
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
    };
  },
};
