/**
 * Google Search Console - URL Inspection tools
 */

import { z } from 'zod';
import { getSearchConsoleClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import { MCPError } from '../../../types/errors.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('gsc-inspection');

// ============================================
// Inspect URL
// ============================================

const inspectUrlSchema = z.object({
  siteUrl: z.string().describe('Site URL (e.g., https://example.com/)'),
  inspectionUrl: z.string().describe('Full URL to inspect'),
  languageCode: z.string().optional().describe('Language code for messages (e.g., en-US)'),
});

type InspectUrlInput = z.infer<typeof inspectUrlSchema>;

interface InspectUrlOutput {
  inspectionResultLink: string;
  indexStatusResult: {
    verdict: string;
    coverageState: string;
    robotsTxtState: string;
    indexingState: string;
    lastCrawlTime?: string;
    pageFetchState: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs: string;
  };
  mobileUsabilityResult?: {
    verdict: string;
    issues: { issueType: string; message: string }[];
  };
  richResultsResult?: {
    verdict: string;
    detectedItems: { richResultType: string }[];
  };
}

export const gscInspectUrlTool: ToolDefinition<InspectUrlInput, InspectUrlOutput> = {
  name: 'gsc_inspect_url',
  description: 'Inspects a URL to see its index status, mobile usability, and rich results',
  category: ToolCategory.GOOGLE,
  inputSchema: inspectUrlSchema,

  async handler(input: InspectUrlInput): Promise<InspectUrlOutput> {
    log.info('Inspecting URL', {
      siteUrl: input.siteUrl,
      inspectionUrl: input.inspectionUrl,
    });

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.urlInspection.index.inspect({
      requestBody: {
        siteUrl: input.siteUrl,
        inspectionUrl: input.inspectionUrl,
        languageCode: input.languageCode || 'en-US',
      },
    });

    const result = response.data.inspectionResult;

    if (!result) {
      throw MCPError.externalServiceError('searchConsole', 'No inspection result returned');
    }

    const indexStatus = result.indexStatusResult || {};
    const mobileUsability = result.mobileUsabilityResult;
    const richResults = result.richResultsResult;

    log.info('URL inspection completed', {
      verdict: indexStatus.verdict,
      indexingState: indexStatus.indexingState,
    });

    return {
      inspectionResultLink: result.inspectionResultLink || '',
      indexStatusResult: {
        verdict: indexStatus.verdict || '',
        coverageState: indexStatus.coverageState || '',
        robotsTxtState: indexStatus.robotsTxtState || '',
        indexingState: indexStatus.indexingState || '',
        lastCrawlTime: indexStatus.lastCrawlTime || undefined,
        pageFetchState: indexStatus.pageFetchState || '',
        googleCanonical: indexStatus.googleCanonical || undefined,
        userCanonical: indexStatus.userCanonical || undefined,
        crawledAs: indexStatus.crawledAs || '',
      },
      mobileUsabilityResult: mobileUsability ? {
        verdict: mobileUsability.verdict || '',
        issues: (mobileUsability.issues || []).map((issue) => ({
          issueType: issue.issueType || '',
          message: issue.message || '',
        })),
      } : undefined,
      richResultsResult: richResults ? {
        verdict: richResults.verdict || '',
        detectedItems: (richResults.detectedItems || []).map((item) => ({
          richResultType: item.richResultType || '',
        })),
      } : undefined,
    };
  },
};
