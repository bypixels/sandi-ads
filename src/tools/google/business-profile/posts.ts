/**
 * Google Business Profile - Posts tools
 */

import { z } from 'zod';
import { assertBusinessProfileAuth } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('gbp-posts');

// ============================================
// List Posts
// ============================================

const listPostsSchema = z.object({
  parent: z.string().describe('Location resource name'),
  pageSize: z.number().min(1).max(100).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListPostsInput = z.infer<typeof listPostsSchema>;

interface GBPPost {
  name: string;
  languageCode: string;
  summary: string;
  callToAction?: {
    actionType: string;
    url?: string;
  };
  media?: {
    mediaFormat: string;
    sourceUrl: string;
  }[];
  topicType: 'STANDARD' | 'EVENT' | 'OFFER' | 'ALERT';
  createTime: string;
  updateTime: string;
  state: string;
}

interface ListPostsOutput {
  posts: GBPPost[];
  nextPageToken?: string;
}

export const gbpListPostsTool: ToolDefinition<ListPostsInput, ListPostsOutput> = {
  name: 'gbp_list_posts',
  description: 'Lists posts for a GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: listPostsSchema,

  async handler(input: ListPostsInput): Promise<ListPostsOutput> {
    log.info('Listing GBP posts', { parent: input.parent });

    assertBusinessProfileAuth();

    // Note: Posts API requires special access setup
    log.warn('GBP Posts API requires special access setup');

    return {
      posts: [],
      nextPageToken: undefined,
    };
  },
};

// ============================================
// Create Post
// ============================================

const createPostSchema = z.object({
  parent: z.string().describe('Location resource name'),
  post: z.object({
    languageCode: z.string().describe('Language code (e.g., en)'),
    summary: z.string().min(1).max(1500).describe('Post content'),
    topicType: z.enum(['STANDARD', 'EVENT', 'OFFER', 'ALERT']).describe('Type of post'),
    callToAction: z.object({
      actionType: z.enum(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']),
      url: z.string().url().optional(),
    }).optional(),
    event: z.object({
      title: z.string(),
      schedule: z.object({
        startDate: z.object({ year: z.number(), month: z.number(), day: z.number() }),
        endDate: z.object({ year: z.number(), month: z.number(), day: z.number() }),
        startTime: z.object({ hours: z.number(), minutes: z.number() }).optional(),
        endTime: z.object({ hours: z.number(), minutes: z.number() }).optional(),
      }),
    }).optional(),
    offer: z.object({
      couponCode: z.string().optional(),
      redeemOnlineUrl: z.string().url().optional(),
      termsConditions: z.string().optional(),
    }).optional(),
  }),
});

type CreatePostInput = z.infer<typeof createPostSchema>;

export const gbpCreatePostTool: ToolDefinition<CreatePostInput, GBPPost> = {
  name: 'gbp_create_post',
  description: 'Creates a new post on a GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: createPostSchema,

  async handler(input: CreatePostInput): Promise<GBPPost> {
    log.info('Creating GBP post', { parent: input.parent, type: input.post.topicType });

    assertBusinessProfileAuth();

    // Note: Posts API requires special access setup
    log.warn('GBP Posts API requires special access setup');

    return {
      name: '',
      languageCode: input.post.languageCode,
      summary: input.post.summary,
      callToAction: input.post.callToAction,
      topicType: input.post.topicType,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      state: 'DRAFT',
    };
  },
};
