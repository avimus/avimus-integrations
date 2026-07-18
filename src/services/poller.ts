import type { Pool } from 'pg';
import type { RawErpRecord } from '../adapters/types.js';
import type { TenantErpContext } from './types.js';
import { getLastSyncedAt, updateSyncState } from '../db/queries/sync-state.js';
import { enqueue } from '../db/queries/outbox.js';
import { logAudit } from '../db/queries/audit-log.js';
import { transformEvent } from './transformer.js';
import { logger } from '../lib/logger.js';
import { getConfig } from '../config/index.js';

const EVENT_CONCURRENCY = 5;

async function processEvent(
  pool: Pool,
  rawRecord: RawErpRecord,
  context: TenantErpContext,
): Promise<{ enqueued: boolean }> {
  const result = await transformEvent(rawRecord, context, pool);
  if (!result) return { enqueued: false };

  const { tenant, connection, endpoint } = context;
  const correlationId = crypto.randomUUID();

  let aggregateId: string;
  let payload: Record<string, unknown>;

  if (result.action === 'start_journey') {
    aggregateId = result.cpf;
    payload = {
      avimus_action: 'start_journey',
      cpf: result.cpf,
      protocolId: result.protocolId,
      erpName: result.erpName,
      patientName: result.patientName,
      patientBirthDate: result.patientBirthDate,
      patientPhone: result.patientPhone,
      patientEmail: result.patientEmail,
    };
  } else {
    aggregateId = result.match.patientId;
    payload = {
      avimus_action: 'complete_step',
      stepId: result.match.stepId,
      ...result.payload,
    };
  }

  await Promise.all([
    enqueue(pool, {
      tenantId: tenant.id,
      aggregateId,
      eventType: 'erp_event',
      payload,
      correlationId,
      erpName: connection.erp_name,
    }).then(() =>
      logAudit(pool, {
        tenantId: tenant.id,
        action: 'outbox.enqueue',
        component: 'poller',
        recordType: 'outbox',
        erpName: connection.erp_name,
        correlationId,
        details: result.action === 'start_journey'
          ? { endpointId: endpoint.id, action: 'start_journey' }
          : { endpointId: endpoint.id, patientId: result.match.patientId, stepId: result.match.stepId },
      }),
    ),
  ]);

  return { enqueued: true };
}

export async function runSyncCycle(
  pool: Pool,
  context: TenantErpContext,
  signal?: AbortSignal,
): Promise<{ fetched: number; transformed: number; enqueued: number }> {
  const config = getConfig();
  const { tenant, connection, endpoint, adapter } = context;
  const cycleId = crypto.randomUUID();
  const erpName = connection.erp_name;

  const log = logger.child({ tenantId: tenant.id, erpName, endpointId: endpoint.id, cycleId });

  log.info('Sync cycle started');
  await logAudit(pool, {
    tenantId: tenant.id,
    action: 'sync_cycle.start',
    component: 'poller',
    erpName,
    correlationId: cycleId,
    details: { tenantSlug: tenant.slug, endpointId: endpoint.id, path: endpoint.path },
  });

  try {
    const lastSyncedAt = await getLastSyncedAt(pool, endpoint.id);
    const since = lastSyncedAt ?? new Date(Date.now() - config.initialLookbackHours * 60 * 60 * 1000);

    log.info({ since: since.toISOString() }, 'Fetching events from ERP');

    signal?.throwIfAborted();
    const fetchStartedAt = new Date();
    const records = await adapter.fetchRecentEvents(since);
    log.info({ count: records.length }, 'Events fetched');

    if (records.length === 0) {
      log.info('No new events, skipping update');
      return { fetched: 0, transformed: 0, enqueued: 0 };
    }

    let transformed = 0;
    let enqueued = 0;

    for (let i = 0; i < records.length; i += EVENT_CONCURRENCY) {
      signal?.throwIfAborted();
      const batch = records.slice(i, i + EVENT_CONCURRENCY);
      const results = await Promise.all(
        batch.map((record) => processEvent(pool, record, context)),
      );
      for (const r of results) {
        if (r.enqueued) {
          enqueued++;
          transformed++;
        }
      }
    }

    await updateSyncState(pool, tenant.id, endpoint.id, fetchStartedAt);

    log.info({ fetched: records.length, transformed, enqueued }, 'Sync cycle completed');

    await logAudit(pool, {
      tenantId: tenant.id,
      action: 'sync_cycle.complete',
      component: 'poller',
      erpName,
      correlationId: cycleId,
      details: { endpointId: endpoint.id, fetched: records.length, transformed, enqueued },
    });

    return { fetched: records.length, transformed, enqueued };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error({ error: errorMsg }, 'Sync cycle failed');

    await logAudit(pool, {
      tenantId: tenant.id,
      action: 'sync_cycle.error',
      component: 'poller',
      erpName,
      correlationId: cycleId,
      details: { endpointId: endpoint.id, error: errorMsg },
    });

    throw err;
  }
}
