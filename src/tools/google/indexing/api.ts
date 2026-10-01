/**
 * Google Indexing API tools
 */

import { z } from 'zod';
import { getIndexingClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('indexing-api');

// ============================================
// Publish URL Notification
// ============================================

const indexingPublishSchema = z.object({
  url: z.string().url().describe('URL to notify Google about'),
  type: z.enum(['URL_UPDATED', 'URL_DELETED']).describe('Type of notification'),
});

type IndexingPublishInput = z.infer<typeof indexingPublishSchema>;

interface IndexingPublishOutput {
  urlNotificationMetadata: {
    url: string;
    latestUpdate?: {
      url: string;
      type: string;
      notifyTime: string;
    };
    latestRemove?: {
      url: string;
      type: string;
      notifyTime: string;
    };
  };
}

export const indexingPublishTool: ToolDefinition<IndexingPublishInput, IndexingPublishOutput> = {
  name: 'indexing_publish',
  description: 'Notifies Google about a new or updated URL for indexing',
  category: ToolCategory.INDEXING,
  inputSchema: indexingPublishSchema,

  async handler(input: IndexingPublishInput): Promise<IndexingPublishOutput> {
    log.info('Publishing URL notification', { url: input.url, type: input.type });

    const indexing = await getIndexingClient();

    const response = await indexing.urlNotifications.publish({
      requestBody: {
        url: input.url,
        type: input.type,
      },
    });

    const data = response.data;

    const result: IndexingPublishOutput = {
      urlNotificationMetadata: {
        url: data.urlNotificationMetadata?.url || input.url,
        latestUpdate: data.urlNotificationMetadata?.latestUpdate ? {
          url: data.urlNotificationMetadata.latestUpdate.url || '',
          type: data.urlNotificationMetadata.latestUpdate.type || '',
          notifyTime: data.urlNotificationMetadata.latestUpdate.notifyTime || '',
        } : undefined,
        latestRemove: data.urlNotificationMetadata?.latestRemove ? {
          url: data.urlNotificationMetadata.latestRemove.url || '',
          type: data.urlNotificationMetadata.latestRemove.type || '',
          notifyTime: data.urlNotificationMetadata.latestRemove.notifyTime || '',
        } : undefined,
      },
    };

    log.info('URL notification published', { url: input.url });

    return result;
  },
};

// ============================================
// Get URL Notification Status
// ============================================

const indexingGetStatusSchema = z.object({
  url: z.string().url().describe('URL to get notification status for'),
});

type IndexingGetStatusInput = z.infer<typeof indexingGetStatusSchema>;

interface IndexingGetStatusOutput {
  url: string;
  latestUpdate?: {
    url: string;
    type: string;
    notifyTime: string;
  };
  latestRemove?: {
    url: string;
    type: string;
    notifyTime: string;
  };
}

export const indexingGetStatusTool: ToolDefinition<IndexingGetStatusInput, IndexingGetStatusOutput> = {
  name: 'indexing_get_status',
  description: 'Gets the notification status for a URL',
  category: ToolCategory.INDEXING,
  inputSchema: indexingGetStatusSchema,

  async handler(input: IndexingGetStatusInput): Promise<IndexingGetStatusOutput> {
    log.info('Getting URL notification status', { url: input.url });

    const indexing = await getIndexingClient();

    const response = await indexing.urlNotifications.getMetadata({
      url: input.url,
    });

    const data = response.data;

    const result: IndexingGetStatusOutput = {
      url: data.url || input.url,
      latestUpdate: data.latestUpdate ? {
        url: data.latestUpdate.url || '',
        type: data.latestUpdate.type || '',
        notifyTime: data.latestUpdate.notifyTime || '',
      } : undefined,
      latestRemove: data.latestRemove ? {
        url: data.latestRemove.url || '',
        type: data.latestRemove.type || '',
        notifyTime: data.latestRemove.notifyTime || '',
      } : undefined,
    };

    log.info('URL notification status retrieved', { url: input.url });

    return result;
  },
};

// ============================================
// Batch Publish URL Notifications
// ============================================

const indexingBatchPublishSchema = z.object({
  notifications: z.array(z.object({
    url: z.string().url().describe('URL to notify'),
    type: z.enum(['URL_UPDATED', 'URL_DELETED']).describe('Notification type'),
  })).min(1).max(100).describe('URLs to publish (max 100)'),
});

type IndexingBatchPublishInput = z.infer<typeof indexingBatchPublishSchema>;

interface IndexingBatchPublishOutput {
  results: {
    url: string;
    success: boolean;
    error?: string;
    notifyTime?: string;
  }[];
  summary: {
    total: number;
    successful: number;
    failed: number;
  };
}

export const indexingBatchPublishTool: ToolDefinition<IndexingBatchPublishInput, IndexingBatchPublishOutput> = {
  name: 'indexing_batch_publish',
  description: 'Batch notification for multiple URLs (max 100 per request)',
  category: ToolCategory.INDEXING,
  inputSchema: indexingBatchPublishSchema,

  async handler(input: IndexingBatchPublishInput): Promise<IndexingBatchPublishOutput> {
    log.info('Batch publishing URL notifications', { count: input.notifications.length });

    const indexing = await getIndexingClient();

    const results: IndexingBatchPublishOutput['results'] = [];

    // Process notifications with rate limiting (200 per day limit)
    // We'll process them sequentially with small delays
    for (const notification of input.notifications) {
      try {
        const response = await indexing.urlNotifications.publish({
          requestBody: {
            url: notification.url,
            type: notification.type,
          },
        });

        results.push({
          url: notification.url,
          success: true,
          notifyTime: response.data.urlNotificationMetadata?.latestUpdate?.notifyTime ||
                      response.data.urlNotificationMetadata?.latestRemove?.notifyTime ||
                      new Date().toISOString(),
        });

        // Small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({
          url: notification.url,
          success: false,
          error: errorMessage,
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    log.info('Batch publish completed', { total: results.length, successful, failed });

    return {
      results,
      summary: {
        total: results.length,
        successful,
        failed,
      },
    };
  },
};
