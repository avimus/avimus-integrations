import * as cron from 'node-cron';
import { loadConfig } from './config/index.js';
import { getPool, closePool } from './db/index.js';
import { runMultiTenantSyncCycle } from './services/tenant-orchestrator.js';
import { processPendingDeliveries } from './services/outbox-worker.js';
import { withAdvisoryLock, JOB_LOCKS } from './lib/mutex.js';
import { logger } from './lib/logger.js';
import { buildApiServer } from './api/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ env: config.nodeEnv }, 'Starting Ávimus Integrations worker');

  const pool = getPool();

  const api = await buildApiServer(pool, config);
  await api.listen({ port: config.workerApiPort, host: '0.0.0.0' });
  logger.info({ port: config.workerApiPort }, 'Worker HTTP API listening');
  const tasks: cron.ScheduledTask[] = [];
  const controller = new AbortController();

  // Single cron covering the full multi-tenant sync loop
  const syncExpression = `*/${config.pollingIntervalMinutes} * * * *`;
  const syncTask = cron.schedule(syncExpression, async () => {
    const lock = await withAdvisoryLock(pool, JOB_LOCKS.SYNC_CYCLE, async () => {
      await runMultiTenantSyncCycle(pool, controller.signal);
    });
    if (!lock.acquired) {
      logger.warn('Sync cycle skipped — previous cycle still running');
    }
  });
  tasks.push(syncTask);
  logger.info({ schedule: syncExpression }, 'Multi-tenant sync cycle scheduled');

  // Outbox delivery — runs every minute
  const outboxTask = cron.schedule('* * * * *', async () => {
    const lock = await withAdvisoryLock(pool, JOB_LOCKS.OUTBOX_RELAY, async () => {
      await processPendingDeliveries(pool, controller.signal);
    });
    if (!lock.acquired) {
      logger.debug('Outbox relay skipped — previous run still active');
    }
  });
  tasks.push(outboxTask);
  logger.info('Outbox delivery scheduled');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

    const hardExit = setTimeout(() => {
      logger.error('Forced exit after timeout');
      process.exit(1);
    }, 10_000);
    hardExit.unref();

    for (const task of tasks) task.stop();
    controller.abort();

    await api.close();
    await closePool();
    logger.info('Database pool closed');

    clearTimeout(hardExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('Service started successfully');
}

main().catch((err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal error during startup');
  process.exit(1);
});
