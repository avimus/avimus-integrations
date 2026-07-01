import type { Pool } from 'pg';
import { claimPending, markFailed } from '../db/queries/outbox.js';
import { logAudit } from '../db/queries/audit-log.js';
import { ACTION_HANDLERS } from './avimus-actions/index.js';
import { logger, safeLog } from '../lib/logger.js';

const CLAIM_LIMIT = 10;

export async function processPendingDeliveries(
  pool: Pool,
  signal?: AbortSignal,
): Promise<{ delivered: number; failed: number }> {
  const records = await claimPending(pool, CLAIM_LIMIT);

  if (records.length === 0) {
    return { delivered: 0, failed: 0 };
  }

  logger.info({ count: records.length }, 'Processing pending deliveries');

  let delivered = 0;
  let failed = 0;

  for (const record of records) {
    const payload = record.payload as { avimus_action?: string };
    const avimusAction = payload.avimus_action ?? 'complete_step';
    const handler = ACTION_HANDLERS[avimusAction];

    if (!handler) {
      const errorMsg = `Unknown avimus_action: ${avimusAction}`;
      failed++;
      await Promise.all([
        markFailed(pool, record.id, errorMsg, record.correlation_id),
        logAudit(pool, {
          tenantId: record.tenant_id ?? undefined,
          action: 'delivery.failed',
          component: 'outbox-worker',
          recordType: 'outbox',
          recordId: record.id,
          erpName: record.erp_name,
          correlationId: record.correlation_id,
          details: { error: errorMsg, permanent: true },
        }),
      ]);
      logger.error(
        safeLog({ outboxId: record.id, correlationId: record.correlation_id, avimusAction }),
        'Unknown avimus_action — marking as failed',
      );
      continue;
    }

    try {
      await handler(pool, record, signal);
      delivered++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failed++;

      await Promise.all([
        markFailed(pool, record.id, errorMsg, record.correlation_id),
        logAudit(pool, {
          tenantId: record.tenant_id ?? undefined,
          action: 'delivery.failed',
          component: 'outbox-worker',
          recordType: 'outbox',
          recordId: record.id,
          erpName: record.erp_name,
          correlationId: record.correlation_id,
          details: { error: errorMsg, avimusAction },
        }),
      ]);

      logger.error(
        safeLog({
          outboxId: record.id,
          correlationId: record.correlation_id,
          avimusAction,
          error: errorMsg,
        }),
        'Delivery failed',
      );
    }
  }

  logger.info({ delivered, failed }, 'Delivery batch completed');
  return { delivered, failed };
}
