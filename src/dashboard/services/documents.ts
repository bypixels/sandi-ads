/**
 * Documents — resolves the "Documentos" list in the Command Center sidebar
 * into structured payloads the UI can render generically.
 *
 * Each DocType has a resolver that returns the same shape (`DocPayload`).
 * The viewer modal picks rendering by `format` ('text' | 'markdown' |
 * 'json' | 'list'). Adding a new doc = one new resolver here, one new
 * `<li data-doc>` in the HTML, nothing else.
 *
 * Where the data comes from:
 *   - brand-voice / competitor-analysis → site-profile.ts (already in DB)
 *   - seo-audit / site-health           → snapshots cache (run on demand)
 *   - llms-txt                          → snapshots cache (geo_validate_llms_txt)
 *   - content-briefs / articles         → live tool call or placeholder
 *
 * "Actions" surface tool names the user can invoke from the doc viewer
 * (e.g. seo-audit shows a "re-run" action that POSTs to /api/tool/report_seo_audit).
 */

import { siteProfileRepo } from './site-profile.js';
import { snapshotsRepo, type SnapshotKind } from './snapshots.js';
import { executeToolByName } from './dashboard-data.js';
import { sitesStore, type Site } from './sites-store.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('cc-documents');

export const DOC_TYPES = [
  'brand-voice',
  'competitor-analysis',
  'seo-audit',
  'site-health',
  'llms-txt',
  'content-briefs',
  'articles',
] as const;

export type DocType = typeof DOC_TYPES[number];

export function isDocType(value: string): value is DocType {
  return (DOC_TYPES as readonly string[]).includes(value);
}

export type DocFormat = 'text' | 'markdown' | 'json' | 'list' | 'empty';

export interface DocAction {
  label: string;
  /** Tool name the consumer should POST to `/api/tool/:name` */
  tool: string;
  /** Suggested input — caller usually merges with site context */
  inputHint?: Record<string, unknown>;
}

export interface DocPayload {
  docType: DocType;
  title: string;
  subtitle?: string;
  format: DocFormat;
  /** For format='text' or 'markdown' */
  content?: string;
  /** For format='json' or 'list' — structured data the UI renders item-by-item */
  data?: unknown;
  /** When applicable: how old the cached snapshot is */
  capturedAt?: string;
  isStale?: boolean;
  /** Tools the viewer offers as one-click actions */
  actions?: DocAction[];
  /** Optional empty-state message + suggested action */
  emptyState?: { message: string; primaryAction?: DocAction };
}

// ---------------------------------------------------------------------------
// Snapshot kind freshness map (per doc type that uses caching)
// ---------------------------------------------------------------------------

const DOC_SNAPSHOT_MAX_AGE: Partial<Record<DocType, { kind: SnapshotKind; maxAge: number }>> = {
  'seo-audit': { kind: 'seo_audit', maxAge: 60 * 60 * 24 },
  'site-health': { kind: 'site_health', maxAge: 60 * 60 * 12 },
  'llms-txt': { kind: 'llms_txt_probe', maxAge: 60 * 60 * 24 },
};

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

async function resolveBrandVoice(site: Site): Promise<DocPayload> {
  const profile = await siteProfileRepo.get(site.id);
  const text = profile?.brandVoice?.trim() ?? '';
  if (!text) {
    return {
      docType: 'brand-voice',
      title: 'Brand Voice',
      subtitle: 'Tono, registro y palabras que definen tu marca',
      format: 'empty',
      emptyState: {
        message: 'No definiste brand voice todavía. Lo usan los tools de content_* para mantener consistencia en los drafts.',
      },
    };
  }
  return {
    docType: 'brand-voice',
    title: 'Brand Voice',
    subtitle: 'Tono y registro de la marca',
    format: 'markdown',
    content: text,
  };
}

async function resolveCompetitorAnalysis(site: Site): Promise<DocPayload> {
  const profile = await siteProfileRepo.get(site.id);
  const comps = profile?.competitors ?? [];
  if (comps.length === 0) {
    return {
      docType: 'competitor-analysis',
      title: 'Análisis de Competidores',
      subtitle: 'Tus rivales en search y AI search',
      format: 'empty',
      emptyState: {
        message: 'Agregá competidores en el perfil del sitio para empezar a comparar.',
      },
    };
  }
  return {
    docType: 'competitor-analysis',
    title: 'Análisis de Competidores',
    subtitle: `${comps.length} competidor(es) configurado(s)`,
    format: 'list',
    data: comps.map((c) => ({
      name: c.name,
      url: c.url,
      notes: c.notes,
    })),
    actions: [
      {
        label: 'Comparar visibilidad en AI search',
        tool: 'geo_competitor_share_of_voice',
        inputHint: {
          brands: [{ name: site.name, domain: site.primaryUrl }, ...comps.map((c) => ({ name: c.name, domain: c.url }))],
          prompts: ['¿Cuáles son las mejores herramientas para ' + (profile?.niche || 'mi industria') + '?'],
        },
      },
    ],
  };
}

async function resolveSeoAudit(site: Site): Promise<DocPayload> {
  if (!site.primaryUrl) {
    return {
      docType: 'seo-audit',
      title: 'Auditoría SEO',
      format: 'empty',
      emptyState: { message: 'El sitio no tiene primaryUrl configurada.' },
    };
  }
  const spec = DOC_SNAPSHOT_MAX_AGE['seo-audit']!;
  try {
    const fresh = await snapshotsRepo.getOrFresh({
      siteId: site.id,
      kind: spec.kind,
      maxAgeSeconds: spec.maxAge,
      producer: () => executeToolByName('report_seo_audit', { url: site.primaryUrl }),
    });
    return {
      docType: 'seo-audit',
      title: 'Auditoría SEO',
      subtitle: site.primaryUrl,
      format: 'json',
      data: fresh.data,
      capturedAt: fresh.capturedAt,
      isStale: fresh.isStale,
      actions: [{ label: 'Re-ejecutar auditoría', tool: 'report_seo_audit', inputHint: { url: site.primaryUrl } }],
    };
  } catch (err) {
    log.error('SEO audit resolver failed', { siteId: site.id, error: err instanceof Error ? err : new Error(String(err)) });
    return {
      docType: 'seo-audit',
      title: 'Auditoría SEO',
      format: 'empty',
      emptyState: {
        message: 'No pude correr la auditoría: ' + (err instanceof Error ? err.message : String(err)),
        primaryAction: { label: 'Reintentar', tool: 'report_seo_audit', inputHint: { url: site.primaryUrl } },
      },
    };
  }
}

async function resolveSiteHealth(site: Site): Promise<DocPayload> {
  if (!site.primaryUrl) {
    return {
      docType: 'site-health',
      title: 'Site Health',
      format: 'empty',
      emptyState: { message: 'El sitio no tiene primaryUrl configurada.' },
    };
  }
  const spec = DOC_SNAPSHOT_MAX_AGE['site-health']!;
  try {
    const fresh = await snapshotsRepo.getOrFresh({
      siteId: site.id,
      kind: spec.kind,
      maxAgeSeconds: spec.maxAge,
      producer: () => executeToolByName('report_site_health', { url: site.primaryUrl }),
    });
    return {
      docType: 'site-health',
      title: 'Site Health',
      subtitle: site.primaryUrl,
      format: 'json',
      data: fresh.data,
      capturedAt: fresh.capturedAt,
      isStale: fresh.isStale,
      actions: [{ label: 'Re-ejecutar', tool: 'report_site_health', inputHint: { url: site.primaryUrl } }],
    };
  } catch (err) {
    return {
      docType: 'site-health',
      title: 'Site Health',
      format: 'empty',
      emptyState: { message: 'No pude correr el health check: ' + (err instanceof Error ? err.message : String(err)) },
    };
  }
}

async function resolveLlmsTxt(site: Site): Promise<DocPayload> {
  if (!site.primaryUrl) {
    return {
      docType: 'llms-txt',
      title: 'llms.txt',
      format: 'empty',
      emptyState: { message: 'El sitio no tiene primaryUrl configurada.' },
    };
  }
  const baseUrl = new URL(site.primaryUrl).origin;
  const spec = DOC_SNAPSHOT_MAX_AGE['llms-txt']!;

  try {
    const fresh = await snapshotsRepo.getOrFresh({
      siteId: site.id,
      kind: spec.kind,
      maxAgeSeconds: spec.maxAge,
      producer: () => executeToolByName('geo_validate_llms_txt', { baseUrl }),
    });

    const probe = (fresh.data as Record<string, unknown> | undefined) ?? {};
    const llmsTxt = (probe as { llmsTxt?: { exists?: boolean; status?: number } }).llmsTxt ?? {};
    const llmsFull = (probe as { llmsFullTxt?: { exists?: boolean; status?: number } }).llmsFullTxt ?? {};
    const recs = ((probe as { recommendations?: string[] }).recommendations) ?? [];

    return {
      docType: 'llms-txt',
      title: 'llms.txt',
      subtitle: `${baseUrl}/llms.txt`,
      format: 'json',
      data: { llmsTxt, llmsFullTxt: llmsFull, recommendations: recs, raw: probe },
      capturedAt: fresh.capturedAt,
      isStale: fresh.isStale,
      actions: [
        { label: 'Re-validar', tool: 'geo_validate_llms_txt', inputHint: { baseUrl } },
        ...(llmsTxt.exists
          ? []
          : [{
              label: 'Generar llms.txt desde GSC',
              tool: 'content_generate_llms_txt',
              inputHint: { siteUrl: site.bindings.gscSiteUrl ?? site.primaryUrl, baseUrl },
            } as DocAction]),
      ],
    };
  } catch (err) {
    log.error('llms.txt resolver failed', { siteId: site.id, error: err instanceof Error ? err : new Error(String(err)) });
    return {
      docType: 'llms-txt',
      title: 'llms.txt',
      subtitle: `${baseUrl}/llms.txt`,
      format: 'empty',
      emptyState: {
        message: 'No pude validar llms.txt: ' + (err instanceof Error ? err.message : String(err)),
        primaryAction: { label: 'Reintentar', tool: 'geo_validate_llms_txt', inputHint: { baseUrl } },
      },
    };
  }
}

function resolveContentBriefs(site: Site): DocPayload {
  return {
    docType: 'content-briefs',
    title: 'Briefs de contenido',
    subtitle: 'Generados desde tu data de GSC',
    format: 'empty',
    emptyState: {
      message: 'Pedile un brief al agente con una keyword específica, o corré los tools content_topic_gaps / content_refresh_candidates.',
      primaryAction: {
        label: 'Encontrar gaps de contenido',
        tool: 'content_topic_gaps',
        inputHint: { siteUrl: site.bindings.gscSiteUrl ?? site.primaryUrl },
      },
    },
  };
}

function resolveArticles(): DocPayload {
  return {
    docType: 'articles',
    title: 'Artículos',
    subtitle: 'Publicados via integración CMS',
    format: 'empty',
    emptyState: {
      message: 'Esta vista necesita una integración con tu CMS (WordPress, Webflow, Ghost). Próximamente.',
    },
  };
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export async function resolveDocument(siteId: string, docType: DocType): Promise<DocPayload> {
  const site = await sitesStore.get(siteId);
  if (!site) throw new Error(`Site ${siteId} not found`);

  switch (docType) {
    case 'brand-voice':         return resolveBrandVoice(site);
    case 'competitor-analysis': return resolveCompetitorAnalysis(site);
    case 'seo-audit':           return resolveSeoAudit(site);
    case 'site-health':         return resolveSiteHealth(site);
    case 'llms-txt':            return resolveLlmsTxt(site);
    case 'content-briefs':      return resolveContentBriefs(site);
    case 'articles':            return resolveArticles();
  }
}
