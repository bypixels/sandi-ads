/**
 * Video module — UGC brief generation + (optional) external rendering.
 *
 * Brief generation is always available (uses Anthropic SDK). Rendering is
 * a stub until the user sets VIDEO_PROVIDER + the matching provider key —
 * then the relevant case in render.ts can be filled in.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { videoDraftBriefTool } from './brief.js';
import { videoRenderClipTool } from './render.js';

export { videoDraftBriefTool, videoRenderClipTool };
export type { VideoBriefOutput, ShotListItem, OnScreenTextItem } from './brief.js';
export type { RenderClipOutput, RenderStatus } from './render.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const videoTools: ToolDefinition<any, any>[] = [
  videoDraftBriefTool,
  videoRenderClipTool,
];
