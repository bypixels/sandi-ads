/**
 * Dashboard module entry point
 *
 * Creates and starts the HTTP dashboard server.
 * Also loads stored credentials on startup so they're available to both
 * MCP (stdio) and Dashboard (HTTP) transports.
 */

import { initializeSecurity } from './services/security-config.js';
import type { Server } from 'node:http';
import { createDashboardServer } from './http-server.js';
import { createServiceLogger } from '../utils/logger.js';
import { DASHBOARD_DEFAULTS } from '../config/defaults.js';
import { credentialStore } from './services/credential-store.js';
import { pingDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { auditLog } from './services/audit-log.js';
import { sitesStore } from './services/sites-store.js';
import { conversationStore } from './services/agent-conversations.js';
import { startMonitorScheduler, stopMonitorScheduler } from './services/gsc-monitor.js';
import {
  startSecurityMonitorScheduler,
  stopSecurityMonitorScheduler,
} from './services/security-monitor.js';
import {
  startDiscussionMonitorScheduler,
  stopDiscussionMonitorScheduler,
} from './services/discussion-monitor.js';
import { startSnapshotPruner, stopSnapshotPruner } from './services/snapshots.js';
import { registerSnapshotSignalHandlers } from './services/snapshot-signals.js';
import { startSocialPublisher } from './services/social-publisher.js';

const log = createServiceLogger('dashboard');

let serverInstance: Server | null = null;
let stopSocialPublisher: (() => Promise<void>) | null = null;

/**
 * Load stored credentials into process.env.
 * Called early in startup so authManager.initialize() picks them up.
 * Safe to call even if no credential file exists.
 */
export function loadStoredCredentials(): void {
  initializeSecurity();
  credentialStore.load();
  credentialStore.applyToEnv();
}

/**
 * Initialize Postgres: verify connection, apply migrations, and import any
 * legacy JSON/JSONL data on first run. Throws if Postgres is unreachable.
 */
async function initDatabase(): Promise<void> {
  await pingDb();
  await runMigrations();
  // Idempotent imports — they no-op if data already exists.
  // Run sites first so audit/conversations can FK to them.
  await sitesStore.importLegacyJson();
  await auditLog.importLegacyJsonl();
  await conversationStore.importLegacyChats();
}

/**
 * Start the dashboard HTTP server
 */
export async function startDashboard(): Promise<Server> {
  const port = parseInt(process.env.DASHBOARD_PORT || String(DASHBOARD_DEFAULTS.port), 10);

  await initDatabase();

  const server = createDashboardServer();

  return new Promise((resolve, reject) => {
    server.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'EADDRINUSE') {
        log.error(`Dashboard port ${port} is already in use`);
      }
      reject(error);
    });

    server.listen(port, process.env.DASHBOARD_HOST || '127.0.0.1', () => {
      serverInstance = server;
      log.info(`Dashboard running at http://localhost:${port}`);
      // Register snapshot → signals hooks BEFORE any snapshot can be saved
      // (the schedulers below may trigger saves).
      registerSnapshotSignalHandlers();
      // Start the GSC alerts watcher (cron-like interval). Idempotent.
      startMonitorScheduler();
      // Start the security monitor (SSL + headers + safe browsing). Idempotent.
      startSecurityMonitorScheduler();
      // Start the discussion monitor (Reddit + HN). Idempotent.
      startDiscussionMonitorScheduler();
      // Start the snapshot retention pruner (24h cadence). Idempotent.
      startSnapshotPruner();
      // Start the FB/IG publisher (approved posts only; honors MUTATIONS_META). Idempotent.
      stopSocialPublisher ??= startSocialPublisher();
      resolve(server);
    });
  });
}

/**
 * Stop the dashboard server
 */
export async function stopDashboard(): Promise<void> {
  if (!serverInstance) return;

  stopMonitorScheduler();
  stopSecurityMonitorScheduler();
  stopDiscussionMonitorScheduler();
  stopSnapshotPruner();
  await stopSocialPublisher?.();
  stopSocialPublisher = null;
  return new Promise((resolve) => {
    serverInstance!.close(async () => {
      log.info('Dashboard server stopped');
      serverInstance = null;
      try { await closeDb(); } catch { /* ignore */ }
      resolve();
    });
  });
}
