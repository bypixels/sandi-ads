/**
 * Validate /llms.txt and /llms-full.txt at a domain root.
 *
 * Spec: https://llmstxt.org/ — requires an H1, optional blockquote summary,
 * sections (H2) with bullet-list link lists.
 */

import { z } from 'zod';
import { fetchUrl } from '../base.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('geo-llms-validate');

const schema = z.object({
  baseUrl: z.string().url().describe('Site origin (e.g. https://example.com)'),
});

type Input = z.infer<typeof schema>;

interface FileReport {
  url: string;
  exists: boolean;
  status: number;
  sizeBytes: number;
  valid: boolean;
  issues: string[];
  parsed: {
    title: string | null;
    summary: string | null;
    sections: { heading: string; linkCount: number }[];
    totalLinks: number;
  };
}

interface Output {
  baseUrl: string;
  llmsTxt: FileReport;
  llmsFullTxt: FileReport;
  recommendations: string[];
}

function parseLlmsTxt(content: string): FileReport['parsed'] {
  const lines = content.split('\n');
  let title: string | null = null;
  let summary: string | null = null;
  const sections: { heading: string; linkCount: number }[] = [];
  let current: { heading: string; linkCount: number } | null = null;
  let totalLinks = 0;

  for (const line of lines) {
    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const blockquote = line.match(/^> (.+)/);
    const link = line.match(/^- \[.+\]\(.+\)/);

    if (h1 && !title) title = h1[1].trim();
    else if (blockquote && !summary && title) summary = blockquote[1].trim();
    else if (h2) {
      current = { heading: h2[1].trim(), linkCount: 0 };
      sections.push(current);
    } else if (link) {
      totalLinks++;
      if (current) current.linkCount++;
    }
  }

  return { title, summary, sections, totalLinks };
}

async function checkFile(url: string): Promise<FileReport> {
  let res: Awaited<ReturnType<typeof fetchUrl>>;
  try {
    res = await fetchUrl(url);
  } catch (e) {
    return {
      url,
      exists: false,
      status: 0,
      sizeBytes: 0,
      valid: false,
      issues: [`Fetch failed: ${(e as Error).message}`],
      parsed: { title: null, summary: null, sections: [], totalLinks: 0 },
    };
  }

  const exists = res.status === 200;
  const sizeBytes = (res.data ?? '').length;
  const issues: string[] = [];

  if (!exists) issues.push(`HTTP ${res.status}`);

  const contentType = res.headers['content-type'] ?? '';
  if (exists && !/text\/(plain|markdown)/.test(contentType)) {
    issues.push(`Content-Type should be text/plain or text/markdown (got: ${contentType || 'missing'})`);
  }

  const parsed = exists ? parseLlmsTxt(res.data) : { title: null, summary: null, sections: [], totalLinks: 0 };

  if (exists) {
    if (!parsed.title) issues.push('Missing required H1 title');
    if (parsed.totalLinks === 0) issues.push('No links found — file appears empty');
    if (parsed.sections.length === 0 && parsed.totalLinks > 0) {
      issues.push('Links present but no H2 sections — structure is malformed');
    }
  }

  return {
    url,
    exists,
    status: res.status,
    sizeBytes,
    valid: exists && issues.length === 0,
    issues,
    parsed,
  };
}

export const geoValidateLlmsTxtTool: ToolDefinition<Input, Output> = {
  name: 'geo_validate_llms_txt',
  description:
    'Validates /llms.txt and /llms-full.txt at a domain root: existence, content-type, spec compliance (H1, sections, links). Returns issues + recommendations.',
  category: ToolCategory.SEO,
  inputSchema: schema,

  async handler(input): Promise<Output> {
    log.info('Validating llms.txt', { baseUrl: input.baseUrl });

    const base = input.baseUrl.replace(/\/$/, '');
    const [llmsTxt, llmsFullTxt] = await Promise.all([checkFile(`${base}/llms.txt`), checkFile(`${base}/llms-full.txt`)]);

    const recommendations: string[] = [];
    if (!llmsTxt.exists) recommendations.push('Crear /llms.txt usando `content_generate_llms_txt`');
    if (llmsTxt.exists && !llmsTxt.valid) recommendations.push('Corregir issues estructurales en /llms.txt');
    if (!llmsFullTxt.exists && llmsTxt.exists) {
      recommendations.push('Considerar publicar /llms-full.txt con contenido completo (no solo links) para mejor extracción por LLMs');
    }
    if (llmsTxt.exists && llmsTxt.parsed.totalLinks < 5) {
      recommendations.push('Aumentar cantidad de URLs en /llms.txt (mínimo 5-10 recomendado)');
    }

    return { baseUrl: input.baseUrl, llmsTxt, llmsFullTxt, recommendations };
  },
};
