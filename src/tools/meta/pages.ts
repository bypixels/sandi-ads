/**
 * Meta Pages and Instagram tools (read-only)
 */

import { z } from 'zod';
import { assertNumericId, metaGet, metaGetAll } from './client.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const numericId = (what: string) => z.string().regex(/^\d+$/, `${what} must be numeric`).describe(what);
const limitSchema = z.number().int().min(1).max(100).optional().describe('Maximum results (default 25, max 100)');

// ============================================
// List Pages
// ============================================

const listPagesSchema = z.object({});

export const metaListPagesTool: ToolDefinition<z.infer<typeof listPagesSchema>, { pages: unknown[] }> = {
  name: 'meta_list_pages',
  description: 'Lists Facebook Pages accessible to the access token, with linked Instagram business accounts',
  category: ToolCategory.META,
  inputSchema: listPagesSchema,
  async handler() {
    const raw = await metaGetAll<Record<string, unknown>>('/me/accounts', {
      fields: 'id,name,category,instagram_business_account{id,username}',
      limit: 100,
    });
    // Page tokens must never leave this module.
    const pages = raw.map((page) => {
      const rest = { ...page };
      delete rest.access_token;
      return rest;
    });
    return { pages };
  },
};

// ============================================
// List Page Posts
// ============================================

const listPagePostsSchema = z.object({
  pageId: numericId('Facebook Page ID'),
  limit: limitSchema,
});

export const metaListPagePostsTool: ToolDefinition<z.infer<typeof listPagePostsSchema>, { posts: unknown[] }> = {
  name: 'meta_list_page_posts',
  description: 'Lists recent posts of a Facebook Page',
  category: ToolCategory.META,
  inputSchema: listPagePostsSchema,
  async handler(input) {
    const res = await metaGet<{ data?: unknown[] }>(`/${assertNumericId(input.pageId, 'pageId')}/posts`, {
      fields: 'id,message,created_time,permalink_url,status_type',
      limit: input.limit ?? 25,
    });
    return { posts: res.data ?? [] };
  },
};

// ============================================
// Get IG Account
// ============================================

const getIgAccountSchema = z.object({
  pageId: numericId('Facebook Page ID'),
});

export const metaGetIgAccountTool: ToolDefinition<z.infer<typeof getIgAccountSchema>, unknown> = {
  name: 'meta_get_ig_account',
  description: 'Gets the Instagram business account linked to a Facebook Page',
  category: ToolCategory.META,
  inputSchema: getIgAccountSchema,
  async handler(input) {
    return metaGet(`/${assertNumericId(input.pageId, 'pageId')}`, {
      fields: 'instagram_business_account{id,username,followers_count,media_count}',
    });
  },
};

// ============================================
// List IG Media
// ============================================

const listIgMediaSchema = z.object({
  igUserId: numericId('Instagram business account ID'),
  limit: limitSchema,
});

export const metaListIgMediaTool: ToolDefinition<z.infer<typeof listIgMediaSchema>, { media: unknown[] }> = {
  name: 'meta_list_ig_media',
  description: 'Lists recent media of an Instagram business account',
  category: ToolCategory.META,
  inputSchema: listIgMediaSchema,
  async handler(input) {
    const res = await metaGet<{ data?: unknown[] }>(`/${assertNumericId(input.igUserId, 'igUserId')}/media`, {
      fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count',
      limit: input.limit ?? 25,
    });
    return { media: res.data ?? [] };
  },
};
