/**
 * video_render_clip — render a video from a brief via an external provider.
 *
 * Today this is a STUB. It dispatches to one of Runway / Pika / Replicate
 * based on `VIDEO_PROVIDER` env var. When the matching provider key is
 * absent, returns `status: 'pending_provider_config'` with a clear message
 * — the dashboard surfaces that as "configurá un provider".
 *
 * To wire a real provider:
 *   1. Set VIDEO_PROVIDER=runway (or pika / replicate).
 *   2. Set the provider's API key env var (e.g. RUNWAY_API_KEY).
 *   3. Implement the provider's call inside the relevant switch case below.
 *      The brief is already structured (hook/main/CTA/shots) so the mapping
 *      to each provider's API is straightforward.
 *
 * The interface returned is provider-agnostic so the UI doesn't need to
 * change when a provider is swapped.
 */

import { z } from 'zod';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('video-render');

const renderClipSchema = z.object({
  /** The full brief (UI fetches the draft and passes its content here). */
  brief: z.object({
    title: z.string(),
    hookScript: z.string(),
    mainScript: z.string(),
    ctaScript: z.string().optional().default(''),
    format: z.enum(['reel', 'short', 'square', 'horizontal']).default('reel'),
    aspectRatio: z.string().default('9:16'),
    durationSec: z.number().int().min(8).max(180).default(30),
    voiceoverInstructions: z.string().optional().default(''),
    moodAndStyle: z.string().optional().default(''),
    shotList: z.array(z.object({
      timestamp: z.string(),
      description: z.string(),
      visualType: z.string(),
      notes: z.string().optional(),
    })).optional().default([]),
  }),
  /** Override the env-configured provider. Useful for A/B'ing models. */
  providerOverride: z.enum(['runway', 'pika', 'replicate']).optional(),
  /** Soft-fail mode: don't throw on missing config, return pending status. */
  dryRun: z.boolean().optional().default(false),
});

type RenderClipInput = z.infer<typeof renderClipSchema>;

export type RenderStatus =
  | 'pending_provider_config'  // no provider env var set
  | 'queued'                    // job accepted by provider
  | 'rendering'                 // in-flight
  | 'done'                      // videoUrl populated
  | 'failed';                   // see message

export interface RenderClipOutput {
  status: RenderStatus;
  provider: string | null;
  jobId: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  /** Provider's published cost estimate for this render, if available. */
  costEstimate: string | null;
  /** Human-readable status note (always present). */
  message: string;
}

interface ProviderRunner {
  (input: RenderClipInput): Promise<RenderClipOutput>;
}

// ---------------------------------------------------------------------------
// Provider stubs — drop-in points for real integrations.
// Each returns pending_provider_config when its API key is absent so the
// dashboard can communicate "configurá VIDEO_PROVIDER=runway and RUNWAY_API_KEY".
// ---------------------------------------------------------------------------

const runwayProvider: ProviderRunner = async () => {
  if (!process.env.RUNWAY_API_KEY) {
    return missing('runway', 'RUNWAY_API_KEY');
  }
  // TODO: implement Runway Gen-3 image-to-video / text-to-video here.
  // Reference: https://docs.dev.runwayml.com
  return {
    status: 'pending_provider_config',
    provider: 'runway',
    jobId: null,
    videoUrl: null,
    thumbnailUrl: null,
    costEstimate: null,
    message: 'Runway provider stub: API key detected, implementation pending. Drop the call into src/tools/video/render.ts → runwayProvider.',
  };
};

const pikaProvider: ProviderRunner = async () => {
  if (!process.env.PIKA_API_KEY) {
    return missing('pika', 'PIKA_API_KEY');
  }
  return {
    status: 'pending_provider_config',
    provider: 'pika',
    jobId: null,
    videoUrl: null,
    thumbnailUrl: null,
    costEstimate: null,
    message: 'Pika provider stub: API key detected, implementation pending.',
  };
};

const replicateProvider: ProviderRunner = async () => {
  if (!process.env.REPLICATE_API_TOKEN) {
    return missing('replicate', 'REPLICATE_API_TOKEN');
  }
  return {
    status: 'pending_provider_config',
    provider: 'replicate',
    jobId: null,
    videoUrl: null,
    thumbnailUrl: null,
    costEstimate: null,
    message: 'Replicate provider stub: API token detected, implementation pending. Many video models hosted there — pick one (Stable Video Diffusion, Zeroscope, etc.) and call.',
  };
};

function missing(provider: string, envVar: string): RenderClipOutput {
  return {
    status: 'pending_provider_config',
    provider,
    jobId: null,
    videoUrl: null,
    thumbnailUrl: null,
    costEstimate: null,
    message: `${provider} provider not configured: set ${envVar} (env var) and restart the dashboard.`,
  };
}

const PROVIDERS: Record<string, ProviderRunner> = {
  runway: runwayProvider,
  pika: pikaProvider,
  replicate: replicateProvider,
};

export const videoRenderClipTool: ToolDefinition<RenderClipInput, RenderClipOutput> = {
  name: 'video_render_clip',
  description:
    'Render a video from a brief via Runway / Pika / Replicate. Provider chosen from VIDEO_PROVIDER env var or providerOverride. Returns pending_provider_config when no provider is wired — the brief is still usable; a human creator can execute it without AI rendering.',
  category: ToolCategory.SEO,
  inputSchema: renderClipSchema,

  async handler(input: RenderClipInput): Promise<RenderClipOutput> {
    const providerName = input.providerOverride ?? process.env.VIDEO_PROVIDER ?? null;
    if (!providerName) {
      log.info('Render skipped — no VIDEO_PROVIDER configured');
      return {
        status: 'pending_provider_config',
        provider: null,
        jobId: null,
        videoUrl: null,
        thumbnailUrl: null,
        costEstimate: null,
        message:
          'No video provider configured. Set VIDEO_PROVIDER=runway|pika|replicate (and the provider\'s API key) to enable rendering. The brief is still usable as a recipe for a human creator.',
      };
    }
    const runner = PROVIDERS[providerName];
    if (!runner) {
      return {
        status: 'failed',
        provider: providerName,
        jobId: null,
        videoUrl: null,
        thumbnailUrl: null,
        costEstimate: null,
        message: `Unknown VIDEO_PROVIDER='${providerName}'. Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
      };
    }
    log.info('Dispatching render', { provider: providerName, durationSec: input.brief.durationSec });
    return runner(input);
  },
};
