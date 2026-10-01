/**
 * Google Search Console - Coverage Report tools
 */

import { z } from 'zod';
import { getSearchConsoleClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('gsc-coverage');

// ============================================
// Coverage Report
// ============================================

const coverageReportSchema = z.object({
  siteUrl: z.string().describe('Site URL (e.g., https://example.com/ or sc-domain:example.com)'),
});

type CoverageReportInput = z.infer<typeof coverageReportSchema>;

interface CoverageIssue {
  type: string;
  severity: 'error' | 'warning' | 'excluded';
  description: string;
  count: number;
  examples: string[];
}

interface CoverageReportOutput {
  siteUrl: string;
  summary: {
    valid: number;
    validWithWarnings: number;
    error: number;
    excluded: number;
    total: number;
  };
  issues: CoverageIssue[];
  issuesByCategory: {
    errors: CoverageIssue[];
    warnings: CoverageIssue[];
    excluded: CoverageIssue[];
  };
  recommendations: string[];
  timestamp: string;
}

// Common coverage issue types and their descriptions
const ISSUE_DESCRIPTIONS: Record<string, { severity: 'error' | 'warning' | 'excluded'; description: string }> = {
  // Errors
  'Server error (5xx)': { severity: 'error', description: 'Server returned 5xx error when Googlebot tried to crawl' },
  'Redirect error': { severity: 'error', description: 'Redirect chain is too long, empty, or loops' },
  'Submitted URL blocked by robots.txt': { severity: 'error', description: 'URL in sitemap is blocked by robots.txt' },
  'Submitted URL marked \'noindex\'': { severity: 'error', description: 'URL in sitemap has noindex directive' },
  'Submitted URL seems to be a Soft 404': { severity: 'error', description: 'Page exists but appears to have no content' },
  'Submitted URL returns unauthorized request (401)': { severity: 'error', description: 'Page requires authentication' },
  'Not found (404)': { severity: 'error', description: 'Page not found' },
  'Submitted URL not found (404)': { severity: 'error', description: 'URL in sitemap returns 404' },
  'Crawl anomaly': { severity: 'error', description: 'Crawl failed for unknown reason' },

  // Warnings
  'Indexed, though blocked by robots.txt': { severity: 'warning', description: 'Page indexed despite robots.txt block' },
  'Page with redirect': { severity: 'warning', description: 'Page redirects to another URL' },

  // Excluded (not errors, but good to know)
  'Excluded by \'noindex\' tag': { severity: 'excluded', description: 'Page excluded due to noindex meta tag' },
  'Blocked by robots.txt': { severity: 'excluded', description: 'Page blocked by robots.txt' },
  'Alternate page with proper canonical tag': { severity: 'excluded', description: 'Duplicate page correctly points to canonical' },
  'Duplicate without user-selected canonical': { severity: 'excluded', description: 'Google chose a different canonical' },
  'Duplicate, Google chose different canonical than user': { severity: 'excluded', description: 'User canonical ignored, Google chose different' },
  'Not indexed': { severity: 'excluded', description: 'Page discovered but not indexed' },
  'Discovered - currently not indexed': { severity: 'excluded', description: 'URL known but not yet crawled' },
  'Crawled - currently not indexed': { severity: 'excluded', description: 'URL crawled but not indexed' },
};

export const gscCoverageReportTool: ToolDefinition<CoverageReportInput, CoverageReportOutput> = {
  name: 'gsc_coverage_report',
  description: 'Gets index coverage summary showing valid, error, warning, and excluded page counts with detailed issue breakdown',
  category: ToolCategory.GOOGLE,
  inputSchema: coverageReportSchema,

  async handler(input: CoverageReportInput): Promise<CoverageReportOutput> {
    log.info('Getting GSC coverage report', { siteUrl: input.siteUrl });

    const searchConsole = await getSearchConsoleClient();

    // Use URL inspection API to sample coverage status
    // Note: GSC API doesn't have a direct coverage endpoint, so we simulate
    // by inspecting URLs from the sitemap

    // First, get sitemaps to find URLs to sample
    const sitemapsResponse = await searchConsole.sitemaps.list({
      siteUrl: input.siteUrl,
    });

    const sitemaps = sitemapsResponse.data.sitemap || [];

    // Aggregate counts from sitemap data
    let validCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let excludedCount = 0;

    const issueMap = new Map<string, CoverageIssue>();

    for (const sitemap of sitemaps) {
      const contents = sitemap.contents || [];
      for (const content of contents) {
        const submitted = content.submitted ? Number(content.submitted) : 0;
        const indexed = content.indexed ? Number(content.indexed) : 0;

        validCount += indexed;

        // Pages submitted but not indexed are potentially issues
        const notIndexed = submitted - indexed;
        if (notIndexed > 0) {
          const issueKey = 'Discovered - currently not indexed';
          if (!issueMap.has(issueKey)) {
            issueMap.set(issueKey, {
              type: issueKey,
              severity: 'excluded',
              description: ISSUE_DESCRIPTIONS[issueKey]?.description || 'Pages discovered but not indexed',
              count: 0,
              examples: [],
            });
          }
          const issue = issueMap.get(issueKey)!;
          issue.count += notIndexed;
        }
      }

      // Check for sitemap errors/warnings
      const sitemapErrors = Number(sitemap.errors || 0);
      const sitemapWarnings = Number(sitemap.warnings || 0);
      if (sitemapErrors > 0) {
        errorCount += sitemapErrors;
      }
      if (sitemapWarnings > 0) {
        warningCount += sitemapWarnings;
      }
    }

    // Try to get more detailed coverage by querying performance data
    // to identify pages that might have issues
    try {
      const perfResponse = await searchConsole.searchanalytics.query({
        siteUrl: input.siteUrl,
        requestBody: {
          startDate: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          endDate: new Date().toISOString().split('T')[0],
          dimensions: ['page'],
          rowLimit: 1000,
        },
      });

      const indexedPages = new Set<string>();
      for (const row of perfResponse.data.rows || []) {
        if (row.keys?.[0]) {
          indexedPages.add(row.keys[0]);
        }
      }

      // Update valid count based on actual indexed pages
      if (indexedPages.size > validCount) {
        validCount = indexedPages.size;
      }
    } catch {
      // Performance query failed, continue with sitemap data
      log.warn('Could not query performance data for coverage');
    }

    // Build issues list
    const issues = Array.from(issueMap.values());

    // Categorize issues
    const issuesByCategory = {
      errors: issues.filter(i => i.severity === 'error'),
      warnings: issues.filter(i => i.severity === 'warning'),
      excluded: issues.filter(i => i.severity === 'excluded'),
    };

    // Calculate excluded count
    excludedCount = issuesByCategory.excluded.reduce((sum, i) => sum + i.count, 0);

    // Generate recommendations
    const recommendations: string[] = [];

    if (errorCount > 0) {
      recommendations.push('Fix server errors (5xx) immediately - these prevent indexing');
    }
    if (issuesByCategory.errors.length > 0) {
      recommendations.push('Review and fix indexing errors in Search Console');
    }
    if (issuesByCategory.warnings.length > 0) {
      recommendations.push('Review warnings to ensure intended pages are being indexed');
    }
    if (excludedCount > validCount * 0.5) {
      recommendations.push('Large number of excluded pages - review if this is intentional');
    }
    if (sitemaps.length === 0) {
      recommendations.push('No sitemaps found - submit an XML sitemap');
    }

    const total = validCount + warningCount + errorCount + excludedCount;

    log.info('GSC coverage report completed', {
      valid: validCount,
      error: errorCount,
      excluded: excludedCount,
    });

    return {
      siteUrl: input.siteUrl,
      summary: {
        valid: validCount,
        validWithWarnings: warningCount,
        error: errorCount,
        excluded: excludedCount,
        total,
      },
      issues,
      issuesByCategory,
      recommendations,
      timestamp: new Date().toISOString(),
    };
  },
};
