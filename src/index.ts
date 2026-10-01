/**
 * Website Operations MCP Server
 *
 * Entry point for the MCP server that provides Claude with tools
 * for website operations, Google Marketing, SEO, Performance,
 * Security & Monitoring.
 */

import 'dotenv/config';
import { startServer } from './server.js';
import { logger } from './utils/logger.js';
import { cacheClear } from './utils/cache.js';
import { getLicenseInfo } from './licensing/index.js';

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
});

// Graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  // Stop dashboard if running (only started for Pro users)
  if (process.env.DASHBOARD_ENABLED === 'true' && getLicenseInfo().tier === 'pro') {
    try {
      const { stopDashboard } = await import('./dashboard/index.js');
      await stopDashboard();
    } catch {
      // Ignore errors during shutdown
    }
  }

  // Clear cache to free memory
  cacheClear();

  // Allow pending logs to flush
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the server
async function main() {
  try {
    const license = getLicenseInfo();
    logger.info(`Sandi Ads — License tier: ${license.tier.toUpperCase()}`, {
      tier: license.tier,
      hasKey: !!license.key,
    });

    if (license.tier === 'free') {
      logger.info(
        'Running in FREE mode. Pro reports and dashboard are disabled. Get a license at https://github.com/bypixels/sandi-ads'
      );
    }

    await startServer();
  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    process.exit(1);
  }
}

main();
