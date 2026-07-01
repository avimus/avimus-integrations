import type { Pool } from 'pg';
import { claimPending, markFailed, scheduleRetry } from '../db/queries/outbox.js';
import { logAudit } from '../db/queries/audit-log.js';
import { ACTION_HANDLERS } from './avimus-actions/index.js';
import { isTransientError } from '../lib/backoff.js';
import { logger, safeLog } from '../lib/logger.js';

const CLAIM_LIMIT = 10;

// Backoff do retry agendado entre ticks do cron (ADR-004): falha transitória
// reagenda a entrega em vez de marcar 'falhou'. Com max_attempts = 6
// (1 tentativa inicial + 5 reagendadas), um registro só vira 'falhou'
// definitivo depois de ~7h de indisponibilidade contínua da Ávimus.
// Erros permanentes (validação, auth, 404) vão direto para 'falhou'.
const RETRY_DELAYS_MS = [
  60_000, // 1 min
  300_000, // 5 min
  900_000, // 15 min
  3_600_000, // 1 h
  21_600_000, // 6 h
];

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

      const attemptsMade = record.attempt_count + 1;
      const transient = isTransientError(err);

      if (transient && attemptsMade < record.max_attempts) {
        const delayMs = RETRY_DELAYS_MS[Math.min(attemptsMade - 1, RETRY_DELAYS_MS.length - 1)];
        const nextRetryAt = new Date(Date.now() + delayMs);

        await Promise.all([
          scheduleRetry(pool, record.id, errorMsg, record.correlation_id, nextRetryAt),
          logAudit(pool, {
            tenantId: record.tenant_id ?? undefined,
            action: 'delivery.retry_scheduled',
            component: 'outbox-worker',
            recordType: 'outbox',
            recordId: record.id,
            erpName: record.erp_name,
            correlationId: record.correlation_id,
            details: { error: errorMsg, avimusAction, attempt: attemptsMade, nextRetryAt: nextRetryAt.toISOString() },
          }),
        ]);

        logger.warn(
          safeLog({
            outboxId: record.id,
            correlationId: record.correlation_id,
            avimusAction,
            error: errorMsg,
            attempt: `${attemptsMade}/${record.max_attempts}`,
            nextRetryAt: nextRetryAt.toISOString(),
          }),
          'Delivery failed — retry scheduled',
        );
        continue;
      }

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
          details: { error: errorMsg, avimusAction, permanent: !transient, attempt: attemptsMade },
        }),
      ]);

      logger.error(
        safeLog({
          outboxId: record.id,
          correlationId: record.correlation_id,
          avimusAction,
          error: errorMsg,
          reason: transient ? 'tentativas esgotadas' : 'erro permanente',
        }),
        'Delivery failed',
      );
    }
  }

  logger.info({ delivered, failed }, 'Delivery batch completed');
  return { delivered, failed };
}
