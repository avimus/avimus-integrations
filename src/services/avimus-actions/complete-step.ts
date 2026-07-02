import type { Pool } from 'pg';
import type { OutboxRecord } from '../../db/queries/outbox.js';
import { markSent, hasRecentSuccess } from '../../db/queries/outbox.js';
import { getTenantAvimusToken } from '../../db/queries/tenants.js';
import { logAudit } from '../../db/queries/audit-log.js';
import { withRetry } from '../../lib/backoff.js';
import { completeStep } from '../../clients/avimus.js';
import { getConfig } from '../../config/index.js';
import { logger, safeLog } from '../../lib/logger.js';

function isPermanentError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    return status === 404 || status === 401 || status === 403;
  }
  return false;
}

export async function completeStepAction(
  pool: Pool,
  record: OutboxRecord,
  signal?: AbortSignal,
): Promise<void> {
  const config = getConfig();
  const payload = record.payload as {
    stepId: string;
    result?: string;
    notes: string;
    executedAt: string;
    metadata: Record<string, unknown>;
  };

  const token = await getTenantAvimusToken(pool, record.tenant_id ?? '');
  if (!token) {
    throw new Error(`Tenant ${record.tenant_id ?? '(none)'} has no avimus_api_token configured`);
  }

  const alreadyCompleted = await hasRecentSuccess(
    pool,
    record.tenant_id ?? '',
    record.aggregate_id,
    record.event_type,
    payload.stepId,
  );
  if (alreadyCompleted) {
    await markSent(pool, record.id);
    logger.info(
      safeLog({ outboxId: record.id, stepId: payload.stepId }),
      'Skipping duplicate — step already completed recently',
    );
    await logAudit(pool, {
      tenantId: record.tenant_id ?? undefined,
      action: 'delivery.skipped_duplicate',
      component: 'outbox-worker',
      recordType: 'outbox',
      recordId: record.id,
      erpName: record.erp_name,
      correlationId: record.correlation_id,
      details: { stepId: payload.stepId },
    });
    return;
  }

  let attempt = 0;

  await withRetry(
    async (retrySignal) => {
      attempt++;
      await completeStep(token, payload.stepId, {
        ...(payload.result ? { result: payload.result } : {}),
        notes: payload.notes,
        executedAt: payload.executedAt,
        metadata: payload.metadata as { erpName: string; protocolId: string },
      }, retrySignal);
    },
    {
      maxAttempts: config.maxRetries,
      baseMs: 500,
      capMs: 10_000,
      signal,
      shouldRetry: (err) => !isPermanentError(err),
      onRetry: ({ attempt: a, delayMs, error }) => {
        logger.warn(
          safeLog({
            outboxId: record.id,
            correlationId: record.correlation_id,
            attempt: a,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
          'Retrying Ávimus delivery',
        );
      },
    },
  );

  await Promise.all([
    markSent(pool, record.id),
    logAudit(pool, {
      tenantId: record.tenant_id ?? undefined,
      action: 'delivery.success',
      component: 'outbox-worker',
      recordType: 'outbox',
      recordId: record.id,
      erpName: record.erp_name,
      correlationId: record.correlation_id,
      details: { stepId: payload.stepId, attempt },
    }),
  ]);
}
