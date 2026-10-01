/**
 * Propose security-header fixes — checks missing headers and emits
 * deployable configs for Cloudflare Transform Rules, nginx, and Apache.
 */

import { z } from 'zod';
import { fetchUrl } from '../base.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('fix-security-headers');

const schema = z.object({
  url: z.string().url().describe('URL to audit'),
  strict: z.boolean().optional().describe('Use strict CSP and HSTS preload values (default false)'),
});

type Input = z.infer<typeof schema>;

interface HeaderProposal {
  name: string;
  current: string | null;
  proposed: string;
  severity: 'critical' | 'recommended' | 'optional';
  rationale: string;
}

interface Output {
  url: string;
  scannedHeaders: Record<string, string>;
  missing: HeaderProposal[];
  applyVia: {
    cloudflareTransformRulesJson: string;
    nginxConfig: string;
    apacheConfig: string;
  };
}

const RECOMMENDED: { name: string; severity: HeaderProposal['severity']; rationale: string; value(strict: boolean): string }[] = [
  {
    name: 'Strict-Transport-Security',
    severity: 'critical',
    rationale: 'Forces HTTPS for all subsequent requests, mitigating downgrade attacks',
    value: (strict) => (strict ? 'max-age=63072000; includeSubDomains; preload' : 'max-age=31536000; includeSubDomains'),
  },
  {
    name: 'Content-Security-Policy',
    severity: 'recommended',
    rationale: 'Mitigates XSS by restricting which scripts and resources can load',
    value: (strict) =>
      strict
        ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        : "default-src 'self' https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; object-src 'none'; frame-ancestors 'self'",
  },
  {
    name: 'X-Content-Type-Options',
    severity: 'critical',
    rationale: 'Prevents MIME-type sniffing attacks',
    value: () => 'nosniff',
  },
  {
    name: 'X-Frame-Options',
    severity: 'critical',
    rationale: 'Prevents clickjacking via iframe embedding',
    value: () => 'SAMEORIGIN',
  },
  {
    name: 'Referrer-Policy',
    severity: 'recommended',
    rationale: 'Limits referrer leakage to third parties',
    value: () => 'strict-origin-when-cross-origin',
  },
  {
    name: 'Permissions-Policy',
    severity: 'optional',
    rationale: 'Disables sensitive browser features by default',
    value: () => 'geolocation=(), microphone=(), camera=(), payment=()',
  },
  {
    name: 'X-Permitted-Cross-Domain-Policies',
    severity: 'optional',
    rationale: 'Blocks legacy Adobe cross-domain access',
    value: () => 'none',
  },
];

function buildCloudflareTransformRules(missing: HeaderProposal[]): string {
  const rules = missing.map((h, i) => ({
    expression: 'true',
    description: `Add ${h.name}`,
    action: 'rewrite',
    action_parameters: {
      headers: {
        [h.name]: { operation: 'set', value: h.proposed },
      },
    },
    priority: i + 1,
    enabled: true,
  }));
  return JSON.stringify({ rules }, null, 2);
}

function buildNginxConfig(missing: HeaderProposal[]): string {
  return missing.map((h) => `add_header ${h.name} "${h.proposed.replace(/"/g, '\\"')}" always;`).join('\n');
}

function buildApacheConfig(missing: HeaderProposal[]): string {
  return missing.map((h) => `Header always set ${h.name} "${h.proposed.replace(/"/g, '\\"')}"`).join('\n');
}

export const fixProposeSecurityHeadersTool: ToolDefinition<Input, Output> = {
  name: 'fix_propose_security_headers',
  description:
    'Audits security headers and produces ready-to-deploy configs for Cloudflare Transform Rules, nginx, and Apache covering only the missing headers. Caller applies the config.',
  category: ToolCategory.SECURITY,
  inputSchema: schema,

  async handler(input): Promise<Output> {
    const strict = input.strict ?? false;
    log.info('Proposing security headers', { url: input.url, strict });

    const res = await fetchUrl(input.url);
    const scanned: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) {
      scanned[k.toLowerCase()] = String(v);
    }

    const missing: HeaderProposal[] = [];
    for (const def of RECOMMENDED) {
      const lc = def.name.toLowerCase();
      const current = scanned[lc];
      if (!current) {
        missing.push({
          name: def.name,
          current: null,
          proposed: def.value(strict),
          severity: def.severity,
          rationale: def.rationale,
        });
      }
    }

    return {
      url: input.url,
      scannedHeaders: scanned,
      missing,
      applyVia: {
        cloudflareTransformRulesJson: buildCloudflareTransformRules(missing),
        nginxConfig: buildNginxConfig(missing),
        apacheConfig: buildApacheConfig(missing),
      },
    };
  },
};
