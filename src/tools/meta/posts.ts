/**
 * Meta organic post drafts.
 *
 * Creates a DRAFT in the own publishing queue and nothing else: it never
 * calls Meta. Approval happens only in the dashboard by the admin; there is
 * deliberately no approve tool for MCP or the agent.
 */

import { z } from 'zod';
import { socialPostsStore, SocialPostValidationError, type SocialPost } from '../../dashboard/services/social-posts-store.js';
import { getPinnedSiteId } from '../../dashboard/auth.js';
import { ErrorCode, MCPError } from '../../types/errors.js';
import type { ToolDefinition, ToolExecutionContext } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const draftPostSchema = z.object({
  siteId: z.string().uuid().describe('Site (client) ID the post belongs to'),
  platforms: z.array(z.enum(['facebook', 'instagram'])).min(1).describe('Target platforms'),
  message: z.string().max(63206).describe('Post text / caption (Instagram max 2200 chars)'),
  imageUrl: z.string().url().optional().describe('Image already uploaded to the site R2 storage (dashboard upload)'),
  scheduledAt: z.string().datetime({ offset: true }).optional()
    .describe('ISO 8601 publish time (5 min to 60 days ahead); omit to publish as soon as approved'),
});

/** Origin recorded on the draft; a direct call without context is the MCP stdio server. */
const CREATED_BY: Record<NonNullable<ToolExecutionContext['sourceKind']>, string> = {
  agent: 'agent', mcp: 'mcp', http: 'dashboard', internal: 'dashboard',
};

export const metaDraftPostTool: ToolDefinition<z.infer<typeof draftPostSchema>, { draft: SocialPost; note: string }> = {
  name: 'meta_draft_post',
  description: 'Creates a Facebook/Instagram post DRAFT for a site. Does not publish: the admin must approve it in the dashboard',
  category: ToolCategory.META,
  inputSchema: draftPostSchema,
  async handler(input, context) {
    const pinned = getPinnedSiteId()?.trim();
    if (pinned && input.siteId !== pinned) {
      throw new MCPError({
        code: ErrorCode.RESOURCE_ACCESS_DENIED,
        message: 'Este servidor está fijado a otro sitio; no puede crear borradores para este sitio.',
        retryable: false,
      });
    }
    try {
      const draft = await socialPostsStore.createDraft({
        siteId: input.siteId,
        platforms: input.platforms,
        message: input.message,
        imageUrl: input.imageUrl ?? null,
        scheduledAt: input.scheduledAt ? Date.parse(input.scheduledAt) : null,
        createdBy: CREATED_BY[context?.sourceKind ?? 'mcp'],
      });
      return { draft, note: 'Borrador creado; requiere aprobación en el dashboard' };
    } catch (err) {
      if (err instanceof SocialPostValidationError) {
        throw MCPError.validationError(err.details.join(' '), { details: err.details });
      }
      throw err;
    }
  },
};
