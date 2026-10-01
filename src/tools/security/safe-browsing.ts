/**
 * Google Safe Browsing API tool
 *
 * Checks URLs against Google's Safe Browsing lists for malware, phishing, etc.
 */

import { z } from 'zod';
import axios from 'axios';
import { createServiceLogger } from '../../utils/logger.js';
import { MCPError, ErrorCode } from '../../types/errors.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('safe-browsing');

const SAFE_BROWSING_API = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

// ============================================
// Safe Browsing Check
// ============================================

const safeBrowsingSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(500).describe('URLs to check (max 500)'),
  threatTypes: z.array(z.enum([
    'MALWARE',
    'SOCIAL_ENGINEERING',
    'UNWANTED_SOFTWARE',
    'POTENTIALLY_HARMFUL_APPLICATION',
  ])).optional().describe('Threat types to check (default: all)'),
  platformTypes: z.array(z.enum([
    'ANY_PLATFORM',
    'WINDOWS',
    'LINUX',
    'OSX',
    'ANDROID',
    'IOS',
  ])).optional().describe('Platform types to check (default: ANY_PLATFORM)'),
});

type SafeBrowsingInput = z.infer<typeof safeBrowsingSchema>;

interface ThreatMatch {
  threatType: string;
  platformType: string;
  threatEntryType: string;
  url: string;
  cacheDuration: string;
}

interface SafeBrowsingOutput {
  safe: boolean;
  checkedUrls: number;
  matches: ThreatMatch[];
  threatSummary: {
    malware: string[];
    socialEngineering: string[];
    unwantedSoftware: string[];
    potentiallyHarmful: string[];
  };
  timestamp: string;
}

export const safeBrowsingTool: ToolDefinition<SafeBrowsingInput, SafeBrowsingOutput> = {
  name: 'security_safe_browsing',
  description: 'Checks URLs against Google Safe Browsing API for malware, phishing, and other threats',
  category: ToolCategory.SECURITY,
  inputSchema: safeBrowsingSchema,

  async handler(input: SafeBrowsingInput): Promise<SafeBrowsingOutput> {
    log.info('Checking Safe Browsing', { urlCount: input.urls.length });

    const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY || process.env.GOOGLE_PAGESPEED_API_KEY;

    if (!apiKey) {
      throw new MCPError({
        code: ErrorCode.AUTH_NOT_CONFIGURED,
        message: 'GOOGLE_SAFE_BROWSING_API_KEY not configured. Set GOOGLE_SAFE_BROWSING_API_KEY or GOOGLE_PAGESPEED_API_KEY environment variable.',
        retryable: false,
        service: 'safeBrowsing',
      });
    }

    const threatTypes = input.threatTypes || [
      'MALWARE',
      'SOCIAL_ENGINEERING',
      'UNWANTED_SOFTWARE',
      'POTENTIALLY_HARMFUL_APPLICATION',
    ];

    const platformTypes = input.platformTypes || ['ANY_PLATFORM'];

    // Build request body
    const requestBody = {
      client: {
        clientId: 'sandi-ads',
        clientVersion: '1.0.0',
      },
      threatInfo: {
        threatTypes,
        platformTypes,
        threatEntryTypes: ['URL'],
        threatEntries: input.urls.map((url) => ({ url })),
      },
    };

    const response = await axios.post(
      `${SAFE_BROWSING_API}?key=${apiKey}`,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const data = response.data;
    const rawMatches = data.matches || [];

    // Process matches
    const matches: ThreatMatch[] = rawMatches.map((m: Record<string, unknown>) => ({
      threatType: String(m.threatType || ''),
      platformType: String(m.platformType || ''),
      threatEntryType: String(m.threatEntryType || ''),
      url: (m.threat as Record<string, string>)?.url || '',
      cacheDuration: String(m.cacheDuration || ''),
    }));

    // Build threat summary
    const threatSummary = {
      malware: [] as string[],
      socialEngineering: [] as string[],
      unwantedSoftware: [] as string[],
      potentiallyHarmful: [] as string[],
    };

    for (const match of matches) {
      const url = match.url;
      switch (match.threatType) {
        case 'MALWARE':
          if (!threatSummary.malware.includes(url)) {
            threatSummary.malware.push(url);
          }
          break;
        case 'SOCIAL_ENGINEERING':
          if (!threatSummary.socialEngineering.includes(url)) {
            threatSummary.socialEngineering.push(url);
          }
          break;
        case 'UNWANTED_SOFTWARE':
          if (!threatSummary.unwantedSoftware.includes(url)) {
            threatSummary.unwantedSoftware.push(url);
          }
          break;
        case 'POTENTIALLY_HARMFUL_APPLICATION':
          if (!threatSummary.potentiallyHarmful.includes(url)) {
            threatSummary.potentiallyHarmful.push(url);
          }
          break;
      }
    }

    const safe = matches.length === 0;

    log.info('Safe Browsing check completed', {
      urlCount: input.urls.length,
      safe,
      threatCount: matches.length,
    });

    return {
      safe,
      checkedUrls: input.urls.length,
      matches,
      threatSummary,
      timestamp: new Date().toISOString(),
    };
  },
};
