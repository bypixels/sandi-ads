/**
 * coding_propose_fix — LLM-driven structured fix proposal for site ops issues.
 *
 * The dashboard's mechanical `fix_*` tools (fix_resubmit_sitemap,
 * fix_propose_security_headers, etc.) act on a single domain each. The
 * Coding Agent sits above them: it reasons about an issue, decides which
 * tools to invoke, and lays out a plan with rationale + verification.
 *
 * Stateless: returns a structured proposal. The dashboard persists it as a
 * draft (type `fix_proposal`) and a human reviews before any mutation runs.
 *
 * Output is NEVER executed automatically by this tool. Mutations only happen
 * when the user clicks "Apply" on the draft, which routes through the
 * existing guarded-execute pipeline (approval-gate + audit-log).
 */

import { z } from 'zod';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';
import { MCPError } from '../../types/errors.js';
import {
  DEFAULT_SOCIAL_MODEL,
  buildAnthropicClient,
  extractJsonBlock,
  formatBrandContext,
} from '../social/shared.js';

const log = createServiceLogger('coding-propose-fix');

const proposeFixSchema = z.object({
  siteUrl: z.string(),
  problem: z.string().min(10).max(4000).describe('Free-form description of what is wrong'),
  /** Optional GSC signal we are responding to. */
  signal: z.object({
    signalType: z.string(),
    severity: z.string(),
    title: z.string(),
    detail: z.unknown().optional(),
  }).optional(),
  /** Optional snapshot data (Lighthouse output, llms.txt probe, etc.) */
  snapshot: z.object({
    kind: z.string(),
    capturedAt: z.string().optional(),
    data: z.unknown(),
  }).optional(),
  /** Brand context — same shape as social drafters. */
  brandVoice: z.string().max(2000).optional(),
  niche: z.string().max(120).optional(),
  language: z.enum(['es', 'en']).optional(),
  additionalContext: z.string().max(2000).optional(),
  model: z.string().optional(),
});

type ProposeFixInput = z.infer<typeof proposeFixSchema>;

export interface ProposeFixOutput {
  /** Short headline summarizing the proposal. */
  title: string;
  /** One-paragraph diagnosis: what's wrong, scope, severity. */
  diagnosis: string;
  /** LLM's hypothesis for WHY this is happening. */
  rootCause: string;
  /** Ordered, executable steps. Each is concrete (run X tool, change Y config). */
  steps: Array<{ order: number; action: string; rationale: string }>;
  /** Names of `fix_*` tools the agent recommends invoking (in order). */
  toolsToInvoke: Array<{ name: string; whenToRun: string; expectedOutcome: string }>;
  /** What could go wrong + how to mitigate. */
  riskAssessment: string;
  /** How to confirm the fix actually worked (concrete checks). */
  verificationSteps: string[];
  /** When should the human pause + ask for help instead of proceeding. */
  escalationCriteria: string;
  language: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

const KNOWN_FIX_TOOLS = [
  { name: 'fix_resubmit_sitemap', summary: 'Re-submits sitemap.xml to GSC; pings discovery.' },
  { name: 'fix_clean_sitemap', summary: 'Removes 404/redirect URLs from sitemap before re-submitting.' },
  { name: 'fix_submit_pages_to_index', summary: 'Submits specific URLs to Google Indexing API.' },
  { name: 'fix_propose_meta_descriptions', summary: 'Generates meta descriptions for pages missing them.' },
  { name: 'fix_propose_security_headers', summary: 'Proposes HSTS/CSP/X-Frame headers for sites missing them.' },
];

function buildPrompt(input: ProposeFixInput): { system: string; user: string } {
  const lang = input.language ?? 'es';
  const langName = lang === 'es' ? 'español (es-CR)' : 'English';

  const systemParts = [
    `Sos un ingeniero de site operations senior. Trabajás en ${langName}. Tu trabajo es analizar problemas técnicos en sitios web (SEO técnico, performance, security, indexing) y producir propuestas de fix estructuradas que un humano va a revisar y aprobar antes de aplicar.`,
    '',
    '## Reglas',
    '- Diagnóstico antes que solución. NO saltes al "fix" sin entender el "por qué".',
    '- Conservador con mutaciones. Si una acción es irreversible (publicar, borrar, sobrescribir), avisalo en risk.',
    '- Cita data concreta cuando esté disponible. "Tu sitemap tiene 47 URLs pero GSC dice 0 indexadas" es mejor que "hay problemas de indexación".',
    '- Si la información es insuficiente para decidir, decilo: pediste el snapshot, el signal detail no alcanza, etc.',
    '- Cada step debe ser ejecutable. "Mejorar SEO" no es un step; "Re-submit sitemap usando fix_resubmit_sitemap con siteUrl=X" sí.',
    '',
    '## Tools disponibles para recomendar',
    ...KNOWN_FIX_TOOLS.map((t) => `- \`${t.name}\` — ${t.summary}`),
    '',
    'Cuando recomiendes invocar una de estas tools, ponela en `toolsToInvoke` con `whenToRun` (el orden lógico) y `expectedOutcome` (qué esperás ver post-ejecución).',
    '',
    '## Formato de respuesta',
    'Devolvé JSON estricto con esta forma EXACTA:',
    '```json',
    '{',
    '  "title": "fix corto",',
    '  "diagnosis": "qué está pasando, alcance, severidad",',
    '  "rootCause": "tu hipótesis de POR QUÉ",',
    '  "steps": [{"order": 1, "action": "...", "rationale": "..."}],',
    '  "toolsToInvoke": [{"name": "fix_...", "whenToRun": "...", "expectedOutcome": "..."}],',
    '  "riskAssessment": "qué puede salir mal + cómo mitigarlo",',
    '  "verificationSteps": ["chequeo 1", "chequeo 2"],',
    '  "escalationCriteria": "cuándo pausá y pedí ayuda humana"',
    '}',
    '```',
    'NADA fuera del JSON.',
  ];

  systemParts.push(formatBrandContext({
    brandVoice: input.brandVoice,
    niche: input.niche,
  }));

  const userParts = [
    `Sitio: ${input.siteUrl}`,
    '',
    '## Problema',
    input.problem.trim(),
  ];

  if (input.signal) {
    userParts.push('', '## Signal abierto que motivó esto');
    userParts.push(`Type: \`${input.signal.signalType}\` (severity: ${input.signal.severity})`);
    userParts.push(`Title: ${input.signal.title}`);
    if (input.signal.detail) {
      const detailStr = JSON.stringify(input.signal.detail, null, 2).slice(0, 2500);
      userParts.push('', 'Detail:', '```json', detailStr, '```');
    }
  }

  if (input.snapshot) {
    userParts.push('', `## Snapshot data (kind: ${input.snapshot.kind})`);
    if (input.snapshot.capturedAt) userParts.push(`Captured: ${input.snapshot.capturedAt}`);
    const dataStr = JSON.stringify(input.snapshot.data, null, 2).slice(0, 3000);
    userParts.push('', '```json', dataStr, '```');
  }

  if (input.additionalContext && input.additionalContext.trim()) {
    userParts.push('', '## Contexto adicional', input.additionalContext.trim());
  }

  userParts.push('', 'Analizá y producí la propuesta. Solo JSON.');

  return { system: systemParts.join('\n'), user: userParts.join('\n') };
}

export const codingProposeFixTool: ToolDefinition<ProposeFixInput, ProposeFixOutput> = {
  name: 'coding_propose_fix',
  description:
    'Generates a structured fix proposal (diagnosis + steps + tools + risks + verification) for a site ops issue. Stateless — the dashboard persists as a draft, the human reviews, mutations only fire after explicit approval. NEVER auto-executes.',
  category: ToolCategory.SEO,
  inputSchema: proposeFixSchema,

  async handler(input: ProposeFixInput): Promise<ProposeFixOutput> {
    const lang = input.language ?? 'es';
    const model = input.model ?? DEFAULT_SOCIAL_MODEL;
    const { system, user } = buildPrompt(input);

    log.info('Proposing fix', {
      siteUrl: input.siteUrl,
      signalType: input.signal?.signalType ?? null,
      snapshotKind: input.snapshot?.kind ?? null,
      model,
    });

    const client = buildAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw MCPError.externalServiceError('anthropic', 'Coding proposer returned no text content');
    }

    let parsed: Partial<Omit<ProposeFixOutput, 'language' | 'model' | 'tokensInput' | 'tokensOutput'>>;
    try {
      parsed = extractJsonBlock(textBlock.text);
    } catch (err) {
      log.error('Coding proposer produced unparseable JSON', {
        error: err instanceof Error ? err : new Error(String(err)),
        snippet: textBlock.text.slice(0, 200),
      });
      throw MCPError.externalServiceError('anthropic', 'Coding proposer returned malformed JSON');
    }

    if (!parsed.title || !parsed.diagnosis) {
      throw MCPError.externalServiceError('anthropic', 'Coding proposer missing title or diagnosis');
    }

    return {
      title: parsed.title,
      diagnosis: parsed.diagnosis,
      rootCause: parsed.rootCause ?? '',
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      toolsToInvoke: Array.isArray(parsed.toolsToInvoke) ? parsed.toolsToInvoke : [],
      riskAssessment: parsed.riskAssessment ?? '',
      verificationSteps: Array.isArray(parsed.verificationSteps) ? parsed.verificationSteps : [],
      escalationCriteria: parsed.escalationCriteria ?? '',
      language: lang,
      model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
    };
  },
};
