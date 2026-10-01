/**
 * snapshot-signals — turns saved snapshots into Agent Feed signals.
 *
 * Snapshots already exist (lighthouse_*, llms_txt_probe) and are persisted
 * whenever the Command Center refreshes a site or the user triggers a
 * one-shot capture. This module subscribes to `onSnapshotSaved` and emits
 * the GEO + Performance signals whose producer would otherwise not exist.
 *
 * Owned signal kinds (the set this module reconciles):
 *   - GEO:  llms_txt_missing, llms_txt_malformed
 *   - Perf: cwv_poor, lighthouse_score_drop
 *
 * Reconciliation is scoped via `signalsRepo.resolveByTypes` so this module
 * never touches signals owned by gsc-monitor or security-monitor.
 */

import { onSnapshotSaved, type Snapshot, type SnapshotKind } from './snapshots.js';
import { signalsRepo, type SignalSeverity } from './gsc-signals.js';
import type { SignalKind } from './agent-catalog.js';
import { getDb } from '../../db/index.js';
import { siteSnapshots } from '../../db/schema.js';
import { and, desc, eq, lt } from 'drizzle-orm';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('snapshot-signals');

// CWV poor cutoffs — Google's official thresholds (https://web.dev/vitals/)
const CWV_POOR = {
  lcp: 4000,
  fcp: 3000,
  tbt: 600,
  cls: 0.25,
} as const;

const LIGHTHOUSE_SCORE_DROP_HIGH = 15;
const LIGHTHOUSE_SCORE_DROP_WARN = 10;

interface LlmsTxtProbeData {
  llmsTxt?: { exists?: boolean; valid?: boolean; issues?: string[] };
  llmsFullTxt?: { exists?: boolean };
}

interface LighthouseData {
  url?: string;
  formFactor?: string;
  scores?: { performance?: number; accessibility?: number; bestPractices?: number; seo?: number };
  metrics?: {
    largestContentfulPaint?: number;
    firstContentfulPaint?: number;
    totalBlockingTime?: number;
    cumulativeLayoutShift?: number;
  };
}

const LLMS_OWNED: SignalKind[] = ['llms_txt_missing', 'llms_txt_malformed'];
const LIGHTHOUSE_OWNED: SignalKind[] = ['cwv_poor', 'lighthouse_score_drop'];

async function handleLlmsTxt(snap: Snapshot<LlmsTxtProbeData>): Promise<void> {
  const probe = snap.data?.llmsTxt ?? {};
  const exists = probe.exists === true;
  const valid = probe.valid === true;

  const open: string[] = [];

  if (!exists) {
    await signalsRepo.upsertOpen({
      siteId: snap.siteId,
      signalType: 'llms_txt_missing' satisfies SignalKind,
      severity: 'warn',
      title: '/llms.txt no existe — la AI search no tiene mapa estructurado del sitio',
      detail: {
        capturedAt: snap.capturedAt,
        recommendation: 'Generar con content_generate_llms_txt y publicar en la raíz del sitio.',
      },
    });
    open.push('llms_txt_missing');
  } else if (!valid) {
    const issues = probe.issues ?? [];
    await signalsRepo.upsertOpen({
      siteId: snap.siteId,
      signalType: 'llms_txt_malformed' satisfies SignalKind,
      severity: 'low',
      title: `/llms.txt presente pero con ${issues.length} issue(s) estructural(es)`,
      detail: {
        issues,
        capturedAt: snap.capturedAt,
        recommendation: 'Corregir issues reportados por geo_validate_llms_txt.',
      },
    });
    open.push('llms_txt_malformed');
  }

  await signalsRepo.resolveByTypes(snap.siteId, LLMS_OWNED, open);
}

async function handleLighthouse(snap: Snapshot<LighthouseData>): Promise<void> {
  const platform = snap.kind === 'lighthouse_desktop' ? 'desktop' : 'mobile';
  const metrics = snap.data?.metrics ?? {};
  const scores = snap.data?.scores ?? {};

  const open: string[] = [];

  // cwv_poor — any metric breaches its "poor" threshold
  const lcp = metrics.largestContentfulPaint ?? 0;
  const fcp = metrics.firstContentfulPaint ?? 0;
  const tbt = metrics.totalBlockingTime ?? 0;
  const cls = metrics.cumulativeLayoutShift ?? 0;
  const breaches: string[] = [];
  if (lcp >= CWV_POOR.lcp) breaches.push(`LCP ${(lcp / 1000).toFixed(1)}s`);
  if (fcp >= CWV_POOR.fcp) breaches.push(`FCP ${(fcp / 1000).toFixed(1)}s`);
  if (tbt >= CWV_POOR.tbt) breaches.push(`TBT ${Math.round(tbt)}ms`);
  if (cls >= CWV_POOR.cls) breaches.push(`CLS ${cls.toFixed(3)}`);

  if (breaches.length > 0) {
    const severity: SignalSeverity = breaches.length >= 3 ? 'high' : 'warn';
    await signalsRepo.upsertOpen({
      siteId: snap.siteId,
      signalType: 'cwv_poor' satisfies SignalKind,
      severity,
      title: `Core Web Vitals pobres (${platform}): ${breaches.join(', ')}`,
      detail: {
        platform,
        breaches,
        metrics,
        capturedAt: snap.capturedAt,
        recommendation: 'Correr lighthouse_audit con detalle y revisar opportunities prioritarias.',
      },
    });
    open.push('cwv_poor');
  }

  // lighthouse_score_drop — compare performance vs the immediately prior snapshot
  const perf = scores.performance;
  if (typeof perf === 'number') {
    const prior = await loadPriorSnapshot<LighthouseData>(snap.siteId, snap.kind, snap.id);
    const priorPerf = prior?.data?.scores?.performance;
    if (typeof priorPerf === 'number') {
      const drop = priorPerf - perf;
      if (drop >= LIGHTHOUSE_SCORE_DROP_HIGH) {
        await signalsRepo.upsertOpen({
          siteId: snap.siteId,
          signalType: 'lighthouse_score_drop' satisfies SignalKind,
          severity: 'high',
          title: `Performance (${platform}) cayó ${drop} pts (${priorPerf} → ${perf})`,
          detail: {
            platform,
            priorPerformance: priorPerf,
            currentPerformance: perf,
            drop,
            priorCapturedAt: prior?.capturedAt,
            capturedAt: snap.capturedAt,
          },
        });
        open.push('lighthouse_score_drop');
      } else if (drop >= LIGHTHOUSE_SCORE_DROP_WARN) {
        await signalsRepo.upsertOpen({
          siteId: snap.siteId,
          signalType: 'lighthouse_score_drop' satisfies SignalKind,
          severity: 'warn',
          title: `Performance (${platform}) bajó ${drop} pts (${priorPerf} → ${perf})`,
          detail: {
            platform,
            priorPerformance: priorPerf,
            currentPerformance: perf,
            drop,
            priorCapturedAt: prior?.capturedAt,
            capturedAt: snap.capturedAt,
          },
        });
        open.push('lighthouse_score_drop');
      }
    }
  }

  await signalsRepo.resolveByTypes(snap.siteId, LIGHTHOUSE_OWNED, open);
}

/**
 * The snapshot immediately before `currentId` for the same (siteId, kind).
 * Used to detect lighthouse score drops without adding a method to the repo
 * (one private call site).
 */
async function loadPriorSnapshot<T>(
  siteId: string,
  kind: SnapshotKind,
  currentId: number,
): Promise<Snapshot<T> | null> {
  const rows = await getDb()
    .select()
    .from(siteSnapshots)
    .where(
      and(
        eq(siteSnapshots.siteId, siteId),
        eq(siteSnapshots.kind, kind),
        lt(siteSnapshots.id, currentId),
      ),
    )
    .orderBy(desc(siteSnapshots.capturedAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    siteId: r.siteId,
    kind: r.kind as SnapshotKind,
    data: r.data as T,
    capturedAt: r.capturedAt,
  };
}

/**
 * Register handlers. Called once at boot from src/dashboard/index.ts. Safe
 * to call multiple times in tests — but the hook list will grow; tests that
 * stub modules should avoid re-importing this module.
 */
export function registerSnapshotSignalHandlers(): void {
  onSnapshotSaved(async (snap) => {
    try {
      if (snap.kind === 'llms_txt_probe') {
        await handleLlmsTxt(snap as Snapshot<LlmsTxtProbeData>);
      } else if (snap.kind === 'lighthouse_mobile' || snap.kind === 'lighthouse_desktop') {
        await handleLighthouse(snap as Snapshot<LighthouseData>);
      }
    } catch (err) {
      log.warn('Snapshot signal derivation failed', {
        siteId: snap.siteId,
        kind: snap.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  log.info('Snapshot signal handlers registered');
}
