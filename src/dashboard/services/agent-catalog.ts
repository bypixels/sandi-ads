/**
 * AgentCatalog — single source of truth for "what counts as an Agent and
 * which signals belong to it."
 *
 * Why this module exists:
 *   - The frontend Command Center groups signals by "agent" (SEO, GEO,
 *     Content, Fix, Performance, Security, GBP, A11y). That grouping used to
 *     live as a hardcoded map in HTML, with the producer (gsc-monitor) and
 *     consumer (frontend) coupled only by string convention — silent drift
 *     when one side renamed a signal.
 *   - Now: the SignalKind union is the closed set of legal signal strings.
 *     `gsc-monitor.ts` (the writer) and `/api/cc/agents` (the reader) both
 *     import from here. Renaming requires changing this file, and TypeScript
 *     exhaustiveness checks catch every consumer.
 *   - Each Agent declares its `suggestedActions` — tool names callers can
 *     invoke to remediate the agent's open signals. This is what powers the
 *     "next action" CTA on each agent card.
 *
 * Adding a new signal: append to `SignalKind`, add an entry in `SIGNAL_TO_AGENT`,
 * update the producer (typically a gsc-monitor detector). Compiler tells you
 * what else to touch.
 */

import type { Signal } from './gsc-signals.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('agent-catalog');

// ---------------------------------------------------------------------------
// SignalKind — the closed set of strings that may appear in gsc_signals.signal_type
// ---------------------------------------------------------------------------

export const SIGNAL_KINDS = [
  // SEO Agent — GSC monitor emits these today
  'coverage_errors',
  'coverage_high_excluded',
  'sitemap_errors',
  'sitemap_zero_indexed',
  'traffic_drop',

  // SEO — reserved for future detectors
  'gsc_position_drop',
  'gsc_query_lost',

  // GEO Agent
  'geo_low_visibility',
  'llms_txt_missing',
  'llms_txt_malformed',

  // Discussion / community opportunities (Discussion Monitor → Reddit + HN agents)
  'reddit_thread_opportunity',
  'hn_discussion_match',

  // Content Agent
  'gsc_query_near_miss',
  'gsc_page_declining',
  'content_gap',

  // Fix Agent — emitted when a fix_* tool produces a proposal needing approval
  'fix_proposed',
  'fix_queued',

  // Performance Agent
  'cwv_poor',
  'lighthouse_score_drop',

  // Security Agent
  'security_header_missing',
  'ssl_expiring',
  'safe_browsing_flag',

  // GBP Agent
  'gbp_review_new',
  'gbp_post_due',

  // A11y Agent
  'a11y_issue',
] as const;

export type SignalKind = typeof SIGNAL_KINDS[number];

export function isKnownSignalKind(value: string): value is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// AgentId — the closed set of agent identifiers
// ---------------------------------------------------------------------------

export type AgentId =
  | 'seo'
  | 'geo'
  | 'content'
  | 'writer'
  | 'social-x'
  | 'social-linkedin'
  | 'social-hn'
  | 'reddit'
  | 'video'
  | 'coding'
  | 'fix'
  | 'perf'
  | 'security'
  | 'gbp'
  | 'a11y';

export interface AgentDef {
  id: AgentId;
  /** Short label as shown in UI (UPPERCASE handled by CSS). */
  displayName: string;
  /** One-line role description for prompts and tooltips. */
  description: string;
  /** CSS class suffix used by `.cc-agent-icon.{cls}` for color. */
  iconClass: string;
  /** Glyph rendered in the avatar circle. Plain Unicode, no emoji deps. */
  iconGlyph: string;
  /** Status copy when the agent has zero open signals. */
  idleStatus: string;
  /** Builder for the status copy when the agent has open signals. */
  activeStatus: (openCount: number) => string;
  /**
   * Tools the agent suggests running when it has open signals. The first one
   * is the canonical "primary action" — what a one-click CTA invokes.
   */
  suggestedActions: string[];
}

export const AGENT_DEFS: Record<AgentId, AgentDef> = {
  seo: {
    id: 'seo',
    displayName: 'SEO Agent',
    description: 'Auditoría técnica + monitoreo de coverage, sitemaps y rankings en GSC.',
    iconClass: 'seo',
    iconGlyph: '⌖',
    idleStatus: 'Sin issues detectados',
    activeStatus: (n) => `${n} issue(s) detectado(s)`,
    suggestedActions: ['report_seo_audit', 'gsc_coverage_report', 'fix_resubmit_sitemap'],
  },
  geo: {
    id: 'geo',
    displayName: 'GEO Agent',
    description: 'Visibilidad en AI search (ChatGPT, Perplexity) + llms.txt.',
    iconClass: 'geo',
    iconGlyph: '◎',
    idleStatus: 'Sin oportunidades pendientes',
    activeStatus: (n) => `${n} oportunidades de visibilidad AI`,
    // Primary action must auto-fill from site context (no user input). Brand
    // visibility check requires meaningful prompts → it's a secondary action
    // invoked from the doc viewer where inputHint provides them explicitly.
    suggestedActions: ['geo_validate_llms_txt', 'geo_ai_search_friendly_audit', 'content_generate_llms_txt'],
  },
  content: {
    id: 'content',
    displayName: 'Content Agent',
    description: 'Gaps de contenido y refresh candidates desde GSC.',
    iconClass: 'content',
    iconGlyph: '▤',
    idleStatus: 'Sin gaps pendientes',
    activeStatus: (n) => `${n} temas/refresh listos`,
    suggestedActions: ['content_topic_gaps', 'content_refresh_candidates', 'content_brief_from_keyword'],
  },
  writer: {
    id: 'writer',
    displayName: 'Writer Agent',
    description: 'Genera artículos completos con tu brand voice + GSC briefs.',
    iconClass: 'writer',
    iconGlyph: '✎',
    idleStatus: 'Esperando keyword o brief',
    activeStatus: (n) => `${n} draft(s) en revisión`,
    // Custom-routed: this agent's primary action is /api/drafts/agents/writer/run,
    // not /api/tool/:name — the UI knows to dispatch it via the agent-run endpoint
    // because the action name starts with "writer.".
    suggestedActions: ['writer.run', 'content_brief_from_keyword'],
  },
  'social-x': {
    id: 'social-x',
    displayName: 'X Agent',
    description: 'Draftea tweets y threads para X con tu brand voice.',
    iconClass: 'social-x',
    iconGlyph: '𝕏',
    idleStatus: 'Esperando tema o artículo',
    activeStatus: (n) => `${n} draft(s) en revisión`,
    suggestedActions: ['social-x.run', 'social_draft_x'],
  },
  'social-linkedin': {
    id: 'social-linkedin',
    displayName: 'LinkedIn Agent',
    description: 'Draftea posts long-form para LinkedIn con narrative arc.',
    iconClass: 'social-linkedin',
    iconGlyph: 'in',
    idleStatus: 'Esperando tema o artículo',
    activeStatus: (n) => `${n} draft(s) en revisión`,
    suggestedActions: ['social-linkedin.run', 'social_draft_linkedin'],
  },
  'social-hn': {
    id: 'social-hn',
    displayName: 'Hacker News Agent',
    description: 'Drafts de comentarios HN — anti-marketing, community-sensitive.',
    iconClass: 'social-hn',
    iconGlyph: 'Y',
    idleStatus: 'Esperando thread o tema',
    activeStatus: (n) => `${n} discusión/draft(s)`,
    suggestedActions: ['social-hn.run', 'social_draft_hn'],
  },
  reddit: {
    id: 'reddit',
    displayName: 'Reddit Agent',
    description: 'Encuentra threads relevantes en Reddit y draftea respuestas.',
    iconClass: 'reddit',
    iconGlyph: '◷',
    idleStatus: 'Esperando thread u oportunidad',
    activeStatus: (n) => `${n} thread(s)/draft(s)`,
    suggestedActions: ['reddit.run', 'reddit_search_threads', 'reddit_draft_reply'],
  },
  coding: {
    id: 'coding',
    displayName: 'Coding Agent',
    description: 'LLM-driven fix proposals: diagnóstico + plan + verification para issues técnicos.',
    iconClass: 'coding',
    iconGlyph: '⚙',
    idleStatus: 'Esperando issue para analizar',
    activeStatus: (n) => `${n} propuesta(s) en revisión`,
    suggestedActions: ['coding.run', 'coding_propose_fix'],
  },
  video: {
    id: 'video',
    displayName: 'Video Agent',
    description: 'Briefs de UGC video con shot list. Render opcional via Runway/Pika/Replicate.',
    iconClass: 'video',
    iconGlyph: '▶',
    idleStatus: 'Esperando tema',
    activeStatus: (n) => `${n} brief(s) en revisión`,
    suggestedActions: ['video.run', 'video_draft_brief'],
  },
  fix: {
    id: 'fix',
    displayName: 'Fix Agent',
    description: 'Aplica fixes propuestos (con approval gate) y cola de mutaciones.',
    iconClass: 'fix',
    iconGlyph: '✓',
    idleStatus: 'Cola vacía',
    activeStatus: (n) => `${n} fixes en cola`,
    suggestedActions: ['fix_submit_pages_to_index', 'fix_propose_security_headers', 'fix_propose_meta_descriptions'],
  },
  perf: {
    id: 'perf',
    displayName: 'Performance Agent',
    description: 'Core Web Vitals + Lighthouse scoring mobile/desktop.',
    iconClass: 'perf',
    iconGlyph: '⚡',
    idleStatus: 'Performance OK',
    activeStatus: (n) => `${n} páginas bajo umbral`,
    suggestedActions: ['lighthouse_audit', 'cwv_report', 'psi_analyze'],
  },
  security: {
    id: 'security',
    displayName: 'Security Agent',
    description: 'SSL, security headers, Safe Browsing flags.',
    iconClass: 'security',
    iconGlyph: '⛨',
    idleStatus: 'Sin alertas críticas',
    activeStatus: (n) => `${n} alertas de seguridad`,
    suggestedActions: ['security_audit', 'security_headers_check', 'fix_propose_security_headers'],
  },
  gbp: {
    id: 'gbp',
    displayName: 'GBP Agent',
    description: 'Google Business Profile — reviews, posts, insights.',
    iconClass: 'gbp',
    iconGlyph: '◉',
    idleStatus: 'GBP al día',
    activeStatus: (n) => `${n} acciones de Business Profile`,
    suggestedActions: ['gbp_list_reviews', 'gbp_performance_report', 'gbp_create_post'],
  },
  a11y: {
    id: 'a11y',
    displayName: 'A11y Agent',
    description: 'WCAG audits, contrast, alt-text.',
    iconClass: 'a11y',
    iconGlyph: '◍',
    idleStatus: 'WCAG OK',
    activeStatus: (n) => `${n} issues de accesibilidad`,
    suggestedActions: ['a11y_audit', 'a11y_check_contrast', 'a11y_check_images'],
  },
};

// ---------------------------------------------------------------------------
// Signal → Agent mapping
// Producer (gsc-monitor) writes from SignalKind, consumer (routes) reads here.
// The compiler enforces that every kind in the union has an entry.
// ---------------------------------------------------------------------------

export const SIGNAL_TO_AGENT: Record<SignalKind, AgentId> = {
  coverage_errors: 'seo',
  coverage_high_excluded: 'seo',
  sitemap_errors: 'seo',
  sitemap_zero_indexed: 'seo',
  traffic_drop: 'seo',
  gsc_position_drop: 'seo',
  gsc_query_lost: 'seo',

  geo_low_visibility: 'geo',
  llms_txt_missing: 'geo',
  llms_txt_malformed: 'geo',

  reddit_thread_opportunity: 'reddit',
  hn_discussion_match: 'social-hn',

  gsc_query_near_miss: 'content',
  gsc_page_declining: 'content',
  content_gap: 'content',

  fix_proposed: 'fix',
  fix_queued: 'fix',

  cwv_poor: 'perf',
  lighthouse_score_drop: 'perf',

  security_header_missing: 'security',
  ssl_expiring: 'security',
  safe_browsing_flag: 'security',

  gbp_review_new: 'gbp',
  gbp_post_due: 'gbp',

  a11y_issue: 'a11y',
};

/**
 * Resolve which Agent a signal belongs to. Returns null when the signal type
 * is not in the registry (legacy data or in-flight rename). Caller decides
 * how to display unknown signals.
 */
export function getAgentForSignal(signalType: string): AgentId | null {
  if (!isKnownSignalKind(signalType)) return null;
  return SIGNAL_TO_AGENT[signalType];
}

// ---------------------------------------------------------------------------
// Aggregation primitives — consumed by the /api/cc/agents route
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: AgentId;
  displayName: string;
  description: string;
  iconClass: string;
  iconGlyph: string;
  openCount: number;
  status: string;
  /** Worst severity across the agent's open signals. */
  worstSeverity: Signal['severity'] | 'none';
  primaryAction: string | null;
  suggestedActions: string[];
}

const SEVERITY_RANK: Record<Signal['severity'], number> = {
  info: 1, low: 2, warn: 3, high: 4, critical: 5,
};

/**
 * Build the per-agent summary the Command Center renders.
 * Signals whose type is not known stay in the result under id 'seo' fallback?
 *   NO — they're omitted. The frontend separately can show "X unknown signals"
 *   if that ever matters; for now silent drop forces us to keep the catalog
 *   honest.
 */
export function buildAgentSummary(signals: Signal[]): AgentSummary[] {
  const buckets: Record<AgentId, Signal[]> = {
    seo: [], geo: [], content: [], writer: [],
    'social-x': [], 'social-linkedin': [], 'social-hn': [], reddit: [], video: [], coding: [],
    fix: [], perf: [], security: [], gbp: [], a11y: [],
  };
  const unknownKinds = new Set<string>();
  for (const s of signals) {
    const agent = getAgentForSignal(s.signalType);
    if (!agent) {
      unknownKinds.add(s.signalType);
      continue;
    }
    buckets[agent].push(s);
  }
  if (unknownKinds.size > 0) {
    // Surface catalog drift: a producer is emitting a signalType that has no
    // home in SIGNAL_TO_AGENT. Frontend silently dropped them; this is the
    // only place an operator can find out.
    log.warn('Signals dropped from agent summary (unknown signalType)', {
      kinds: [...unknownKinds],
      count: signals.filter((s) => unknownKinds.has(s.signalType)).length,
    });
  }

  const order: AgentId[] = [
    'seo', 'geo', 'content', 'writer',
    'social-x', 'social-linkedin', 'social-hn', 'reddit', 'video',
    'coding', 'fix', 'perf', 'security', 'gbp', 'a11y',
  ];
  return order.map((id) => {
    const def = AGENT_DEFS[id];
    const open = buckets[id];
    const n = open.length;
    const worstSeverity = n === 0
      ? ('none' as const)
      : open.reduce<Signal['severity']>(
          (acc, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[acc] ? s.severity : acc),
          'info',
        );
    return {
      id,
      displayName: def.displayName,
      description: def.description,
      iconClass: def.iconClass,
      iconGlyph: def.iconGlyph,
      openCount: n,
      status: n === 0 ? def.idleStatus : def.activeStatus(n),
      worstSeverity,
      primaryAction: def.suggestedActions[0] ?? null,
      suggestedActions: def.suggestedActions,
    };
  });
}

export interface AgentDetail {
  id: AgentId;
  displayName: string;
  description: string;
  iconClass: string;
  iconGlyph: string;
  openCount: number;
  signals: Signal[];
  suggestedActions: string[];
  primaryAction: string | null;
}

/**
 * Render a list of open signals as a markdown block suitable for the agent's
 * system prompt. The catalog owns BOTH the UI rendering (icons, severities)
 * AND the prompt rendering — so if a severity label or formatting convention
 * changes, the human-facing column and the LLM-facing prompt stay in sync.
 *
 * Returns empty string when there are no signals, so callers can simply
 * `lines.push(formatSignalsForPrompt(...))` without a length check.
 */
export function formatSignalsForPrompt(signals: Signal[]): string {
  if (signals.length === 0) return '';
  const lines: string[] = [
    '',
    '## Alertas abiertas para este sitio',
    '',
    'Estas son condiciones detectadas por el monitor automático que requieren atención. Si el usuario te pregunta algo relacionado, mencionalas. Si te dice "revisá las alertas" o "qué está pasando con el sitio", explicá las relevantes y proponé pasos para resolverlas.',
    '',
  ];
  for (const s of signals) {
    const ack = s.acknowledged ? ' (reconocida)' : '';
    const agentId = getAgentForSignal(s.signalType);
    const agentTag = agentId ? ` _(${AGENT_DEFS[agentId].displayName})_` : '';
    lines.push(`- **[${s.severity.toUpperCase()}]** \`${s.signalType}\`${ack} — ${s.title}${agentTag}`);
  }
  lines.push('', 'Para detalles completos de cada alerta podés llamar tools de inspección (gsc_inspect_url, gsc_query_performance, gsc_coverage_report).');
  return lines.join('\n');
}

export function buildAgentDetail(agentId: AgentId, signals: Signal[]): AgentDetail {
  const def = AGENT_DEFS[agentId];
  const relevant = signals.filter((s) => getAgentForSignal(s.signalType) === agentId);
  return {
    id: agentId,
    displayName: def.displayName,
    description: def.description,
    iconClass: def.iconClass,
    iconGlyph: def.iconGlyph,
    openCount: relevant.length,
    signals: relevant,
    suggestedActions: def.suggestedActions,
    primaryAction: def.suggestedActions[0] ?? null,
  };
}
