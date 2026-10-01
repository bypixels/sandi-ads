/**
 * Auto-fix indexing — submit underperforming/uncrawled URLs to Google's
 * Indexing API in batch. Wraps the existing indexingPublishTool with
 * autodiscovery from GSC.
 *
 * This is a real mutation (Google receives the notification). Caller is
 * expected to gate via approval-gate before invoking.
 */

import { z } from 'zod';
import { executeGoogleApi } from '../google/api-wrapper.js';
import { getSearchConsoleClient } from '../google/search-console/clients.js';
import { getIndexingClient } from '../google/indexing/clients.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('fix-indexing');

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const schema = z.object({
  siteUrl: z.string().describe('GSC site URL (sc-domain:example.com or https://example.com/)'),
  urls: z.array(z.string().url()).optional().describe('Explicit URLs to submit. If omitted, autodiscover from GSC'),
  autoDiscoverMode: z
    .enum(['high_impressions_no_clicks', 'recent_no_data', 'manual'])
    .optional()
    .describe('Discovery strategy when urls omitted (default: high_impressions_no_clicks)'),
  minImpressions: z.number().min(1).optional().describe('Minimum impressions for autodiscover (default 50)'),
  max: z.number().min(1).max(100).optional().describe('Max URLs to submit (default 25, Indexing API daily cap is 200)'),
  type: z.enum(['URL_UPDATED', 'URL_DELETED']).optional().describe('Notification type (default URL_UPDATED)'),
});

type Input = z.infer<typeof schema>;

interface SubmitResult {
  url: string;
  success: boolean;
  notifyTime?: string;
  error?: string;
}

interface Output {
  source: 'explicit' | 'autodiscovered';
  candidatesFound: number;
  attempted: number;
  succeeded: number;
  failed: number;
  results: SubmitResult[];
  quotaWarning?: string;
}

export const fixSubmitPagesToIndexTool: ToolDefinition<Input, Output> = {
  name: 'fix_submit_pages_to_index',
  description:
    'Submits URLs to Google Indexing API. Either pass explicit urls, or autodiscover from GSC pages with impressions but few/no clicks (likely not indexed well). Daily quota 200/day.',
  category: ToolCategory.INDEXING,
  inputSchema: schema,

  async handler(input): Promise<Output> {
    const max = input.max ?? 25;
    const minImp = input.minImpressions ?? 50;
    const type = input.type ?? 'URL_UPDATED';

    let candidates: string[];
    let source: Output['source'];

    if (input.urls && input.urls.length > 0) {
      candidates = input.urls;
      source = 'explicit';
    } else {
      source = 'autodiscovered';
      log.info('Autodiscovering candidates from GSC', { mode: input.autoDiscoverMode, minImp });

      const sc = getSearchConsoleClient();
      const resp = await executeGoogleApi('searchConsole', () =>
        sc.searchanalytics.query({
          siteUrl: input.siteUrl,
          requestBody: {
            startDate: daysAgo(30),
            endDate: daysAgo(1),
            dimensions: ['page'],
            rowLimit: 1000,
          },
        })
      );

      const rows = (resp.data.rows ?? []).map((r) => ({
        page: r.keys?.[0] ?? '',
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        position: r.position ?? 0,
      }));

      const mode = input.autoDiscoverMode ?? 'high_impressions_no_clicks';
      candidates = rows
        .filter((r) => {
          if (mode === 'high_impressions_no_clicks') {
            return r.impressions >= minImp && r.clicks === 0;
          }
          if (mode === 'recent_no_data') {
            return r.impressions > 0 && r.impressions < 10;
          }
          return false;
        })
        .sort((a, b) => b.impressions - a.impressions)
        .map((r) => r.page);
    }

    const toSubmit = candidates.slice(0, max);
    const indexing = getIndexingClient();
    const results: SubmitResult[] = [];

    for (const url of toSubmit) {
      try {
        const resp = await executeGoogleApi('indexing', () =>
          indexing.urlNotifications.publish({ requestBody: { url, type } })
        );
        results.push({
          url,
          success: true,
          notifyTime:
            resp.data.urlNotificationMetadata?.latestUpdate?.notifyTime ??
            resp.data.urlNotificationMetadata?.latestRemove?.notifyTime ??
            new Date().toISOString(),
        });
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        results.push({ url, success: false, error: (e as Error).message });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    const quotaWarning =
      toSubmit.length >= 100 ? 'Approaching daily quota (200/day) — pace remaining submissions.' : undefined;

    log.info('Indexing submission complete', { attempted: toSubmit.length, succeeded, failed });

    return {
      source,
      candidatesFound: candidates.length,
      attempted: toSubmit.length,
      succeeded,
      failed,
      results,
      quotaWarning,
    };
  },
};
