/**
 * Content gap and refresh discovery from GSC data.
 *
 * - content_topic_gaps: queries ranked 11-30 (near-miss opportunities)
 * - content_refresh_candidates: pages with declining traffic OR high-opportunity positions
 */

import { z } from 'zod';
import { executeGoogleApi } from '../google/api-wrapper.js';
import { getSearchConsoleClient } from '../google/search-console/clients.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('content-gaps');

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ============================================
// content_topic_gaps
// ============================================

const topicGapsSchema = z.object({
  siteUrl: z.string().describe('GSC site URL'),
  minImpressions: z.number().min(1).optional().describe('Minimum impressions to consider (default 25)'),
  minPosition: z.number().min(1).max(100).optional().describe('Min position for "near miss" window (default 11)'),
  maxPosition: z.number().min(1).max(100).optional().describe('Max position (default 30)'),
  lookbackDays: z.number().min(7).max(365).optional().describe('Days to look back (default 90)'),
  limit: z.number().min(1).max(500).optional().describe('Max gaps to return (default 50)'),
});

type TopicGapsInput = z.infer<typeof topicGapsSchema>;

interface TopicGap {
  query: string;
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  estClicksAtTop10: number;
  priorityScore: number;
}

interface TopicGapsOutput {
  totalGapsFound: number;
  dateRange: { startDate: string; endDate: string };
  gaps: TopicGap[];
}

export const contentTopicGapsTool: ToolDefinition<TopicGapsInput, TopicGapsOutput> = {
  name: 'content_topic_gaps',
  description:
    'Finds keywords ranking positions 11-30 (just outside top 10) with real impression demand. These are the highest-ROI content opportunities — a small bump = big traffic.',
  category: ToolCategory.SEO,
  inputSchema: topicGapsSchema,

  async handler(input): Promise<TopicGapsOutput> {
    const range = {
      startDate: daysAgo(input.lookbackDays ?? 90),
      endDate: daysAgo(1),
    };
    const minImp = input.minImpressions ?? 25;
    const minPos = input.minPosition ?? 11;
    const maxPos = input.maxPosition ?? 30;
    const limit = input.limit ?? 50;

    log.info('Finding topic gaps', { siteUrl: input.siteUrl, minPos, maxPos });

    const sc = getSearchConsoleClient();
    const resp = await executeGoogleApi('searchConsole', () =>
      sc.searchanalytics.query({
        siteUrl: input.siteUrl,
        requestBody: {
          startDate: range.startDate,
          endDate: range.endDate,
          dimensions: ['query', 'page'],
          rowLimit: 25000,
        },
      })
    );

    const gaps: TopicGap[] = (resp.data.rows ?? [])
      .map((r) => ({
        query: r.keys?.[0] ?? '',
        page: r.keys?.[1] ?? '',
        position: r.position ?? 0,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        ctr: r.ctr ?? 0,
      }))
      .filter((g) => g.position >= minPos && g.position <= maxPos && g.impressions >= minImp)
      .map((g) => {
        const top10Ctr = 0.085;
        const estClicksAtTop10 = Math.round(g.impressions * top10Ctr);
        const priorityScore = Math.round(g.impressions * (1 / Math.max(g.position - 10, 1)));
        return { ...g, estClicksAtTop10, priorityScore };
      })
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, limit);

    return { totalGapsFound: gaps.length, dateRange: range, gaps };
  },
};

// ============================================
// content_refresh_candidates
// ============================================

const refreshCandidatesSchema = z.object({
  siteUrl: z.string().describe('GSC site URL'),
  lookbackDays: z.number().min(14).max(180).optional().describe('Days per period (default 30)'),
  minImpressions: z.number().min(1).optional().describe('Min impressions current period (default 100)'),
  limit: z.number().min(1).max(200).optional().describe('Max candidates (default 30)'),
});

type RefreshCandidatesInput = z.infer<typeof refreshCandidatesSchema>;

interface RefreshCandidate {
  page: string;
  currentImpressions: number;
  previousImpressions: number;
  impressionsDelta: number;
  impressionsDeltaPct: number;
  currentClicks: number;
  previousClicks: number;
  clicksDelta: number;
  currentPosition: number;
  previousPosition: number;
  positionDelta: number;
  refreshScore: number;
  reason: string;
}

interface RefreshCandidatesOutput {
  totalAnalyzed: number;
  currentPeriod: { startDate: string; endDate: string };
  previousPeriod: { startDate: string; endDate: string };
  candidates: RefreshCandidate[];
}

export const contentRefreshCandidatesTool: ToolDefinition<RefreshCandidatesInput, RefreshCandidatesOutput> = {
  name: 'content_refresh_candidates',
  description:
    'Identifies pages losing traffic or stuck in positions 4-15 (high refresh ROI). Compares current vs previous period from GSC and ranks by refresh impact potential.',
  category: ToolCategory.SEO,
  inputSchema: refreshCandidatesSchema,

  async handler(input): Promise<RefreshCandidatesOutput> {
    const days = input.lookbackDays ?? 30;
    const minImp = input.minImpressions ?? 100;
    const limit = input.limit ?? 30;

    const currentPeriod = { startDate: daysAgo(days), endDate: daysAgo(1) };
    const previousPeriod = { startDate: daysAgo(days * 2), endDate: daysAgo(days + 1) };

    log.info('Finding refresh candidates', { currentPeriod, previousPeriod });

    const sc = getSearchConsoleClient();
    const fetchPeriod = (start: string, end: string) =>
      executeGoogleApi('searchConsole', () =>
        sc.searchanalytics.query({
          siteUrl: input.siteUrl,
          requestBody: {
            startDate: start,
            endDate: end,
            dimensions: ['page'],
            rowLimit: 25000,
          },
        })
      );

    const [curr, prev] = await Promise.all([
      fetchPeriod(currentPeriod.startDate, currentPeriod.endDate),
      fetchPeriod(previousPeriod.startDate, previousPeriod.endDate),
    ]);

    type PageStats = { clicks: number; impressions: number; position: number };
    const buildMap = (rows: ReturnType<typeof toRows>): Map<string, PageStats> => {
      const m = new Map<string, PageStats>();
      for (const r of rows) m.set(r.page, { clicks: r.clicks, impressions: r.impressions, position: r.position });
      return m;
    };
    const toRows = (rows: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; position?: number | null }[]) =>
      rows.map((r) => ({
        page: r.keys?.[0] ?? '',
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        position: r.position ?? 0,
      }));

    const currMap = buildMap(toRows(curr.data.rows ?? []));
    const prevMap = buildMap(toRows(prev.data.rows ?? []));

    const candidates: RefreshCandidate[] = [];
    for (const [page, c] of currMap.entries()) {
      if (c.impressions < minImp) continue;
      const p = prevMap.get(page) ?? { clicks: 0, impressions: 0, position: 99 };

      const impressionsDelta = c.impressions - p.impressions;
      const impressionsDeltaPct = p.impressions > 0 ? (impressionsDelta / p.impressions) * 100 : 0;
      const clicksDelta = c.clicks - p.clicks;
      const positionDelta = p.position - c.position;

      const declined = impressionsDeltaPct < -15 && p.impressions >= minImp;
      const stuck = c.position >= 4 && c.position <= 15;

      if (!declined && !stuck) continue;

      let refreshScore = 0;
      const reasons: string[] = [];
      if (declined) {
        refreshScore += Math.abs(impressionsDeltaPct) * 2;
        reasons.push(`Tráfico cayó ${impressionsDeltaPct.toFixed(0)}%`);
      }
      if (stuck) {
        refreshScore += c.impressions / Math.max(c.position - 3, 1);
        reasons.push(`Estancado en posición ${c.position.toFixed(1)}`);
      }

      candidates.push({
        page,
        currentImpressions: c.impressions,
        previousImpressions: p.impressions,
        impressionsDelta,
        impressionsDeltaPct: Math.round(impressionsDeltaPct * 10) / 10,
        currentClicks: c.clicks,
        previousClicks: p.clicks,
        clicksDelta,
        currentPosition: Math.round(c.position * 10) / 10,
        previousPosition: Math.round(p.position * 10) / 10,
        positionDelta: Math.round(positionDelta * 10) / 10,
        refreshScore: Math.round(refreshScore),
        reason: reasons.join(' · '),
      });
    }

    candidates.sort((a, b) => b.refreshScore - a.refreshScore);

    return {
      totalAnalyzed: currMap.size,
      currentPeriod,
      previousPeriod,
      candidates: candidates.slice(0, limit),
    };
  },
};
