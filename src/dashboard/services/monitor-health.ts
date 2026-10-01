/**
 * Monitor health + circuit breaker.
 *
 * After THRESHOLD consecutive failures a (monitor, provider) pair is paused for
 * COOLDOWN_MS so a provider that keeps rejecting us (e.g. Reddit 403) stops
 * spamming logs and burning requests. State is in-memory only: it resets on
 * process restart, which is acceptable because the first failures re-open it.
 */

import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('monitor-health');

const THRESHOLD = 3;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_CHARS = 200;

export type MonitorStatus = 'ok' | 'degraded' | 'paused';

export interface MonitorHealth {
  monitor: string;
  provider: string;
  status: MonitorStatus;
  consecutiveFailures: number;
  lastError?: string;
  lastRunAt?: number;
  lastSuccessAt?: number;
  pausedUntil?: number;
}

interface Entry {
  monitor: string;
  provider: string;
  consecutiveFailures: number;
  lastError?: string;
  lastRunAt?: number;
  lastSuccessAt?: number;
  pausedUntil?: number;
}

const entries = new Map<string, Entry>();

function entryFor(monitor: string, provider: string): Entry {
  const key = monitor + '\u0000' + provider;
  let e = entries.get(key);
  if (!e) {
    e = { monitor, provider, consecutiveFailures: 0 };
    entries.set(key, e);
  }
  return e;
}

/** Strip URL query strings/fragments (they may carry tokens) and cap the length. */
function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/g, '$1').slice(0, MAX_ERROR_CHARS);
}

function close(e: Entry): void {
  e.pausedUntil = undefined;
  e.consecutiveFailures = 0;
  log.info('Monitor circuit closed after cooldown', { monitor: e.monitor, provider: e.provider });
}

export function recordSuccess(monitor: string, provider: string): void {
  const e = entryFor(monitor, provider);
  const now = Date.now();
  e.consecutiveFailures = 0;
  e.lastError = undefined;
  e.lastRunAt = now;
  e.lastSuccessAt = now;
}

/**
 * `pausable: false` is for monitors that never consult isPaused: they can be
 * degraded but must not claim to be paused.
 */
export function recordFailure(monitor: string, provider: string, error: unknown, opts?: { pausable?: boolean }): void {
  const e = entryFor(monitor, provider);
  const now = Date.now();
  e.consecutiveFailures += 1;
  e.lastError = sanitizeError(error);
  e.lastRunAt = now;
  if (opts?.pausable === false) {
    if (e.consecutiveFailures === 1) log.warn('Monitor degraded', { monitor, provider, error: e.lastError });
    return;
  }
  if (e.consecutiveFailures >= THRESHOLD && e.pausedUntil === undefined) {
    e.pausedUntil = now + COOLDOWN_MS;
    log.warn('Monitor circuit opened, pausing provider', {
      monitor, provider, consecutiveFailures: e.consecutiveFailures, pausedUntil: new Date(e.pausedUntil).toISOString(), error: e.lastError,
    });
  }
}

export function isPaused(monitor: string, provider: string, now: number = Date.now()): boolean {
  const e = entries.get(monitor + '\u0000' + provider);
  if (!e || e.pausedUntil === undefined) return false;
  if (now < e.pausedUntil) return true;
  close(e);
  return false;
}

export function getMonitorHealth(): MonitorHealth[] {
  const now = Date.now();
  return [...entries.values()].map((e) => {
    const paused = e.pausedUntil !== undefined && now < e.pausedUntil;
    const status: MonitorStatus = paused ? 'paused' : e.consecutiveFailures > 0 ? 'degraded' : 'ok';
    return { ...e, status };
  });
}

export function _resetForTests(): void {
  entries.clear();
}
