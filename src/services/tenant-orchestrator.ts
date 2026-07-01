import type { Pool } from 'pg';
import { getActiveTenants, getTenantAvimusToken } from '../db/queries/tenants.js';
import { getActiveConnections } from '../db/queries/erp-connections.js';
import { getActiveEndpoints } from '../db/queries/erp-endpoints.js';
import { getFieldMappings } from '../db/queries/field-mappings.js';
import { getEventMappings } from '../db/queries/event-mappings.js';
import { createAdapter } from '../config/erp-registry.js';
import { runSyncCycle } from './poller.js';
import { logger } from '../lib/logger.js';
import type { TenantErpContext } from './types.js';

export async function runMultiTenantSyncCycle(pool: Pool, signal?: AbortSignal): Promise<void> {
  const tenants = await getActiveTenants(pool);
  logger.info({ count: tenants.length }, 'Multi-tenant sync cycle started');

  for (const tenant of tenants) {
    // Buscado uma vez por tenant e reaproveitado em todas as suas
    // conexões/endpoints neste ciclo (ver research: token agora é por
    // tenant, não mais uma credencial global em .env).
    const avimusApiToken = await getTenantAvimusToken(pool, tenant.id);
    const connections = await getActiveConnections(pool, tenant.id);

    for (const connection of connections) {
      const connLog = logger.child({ tenantId: tenant.id, tenantSlug: tenant.slug, erpName: connection.erp_name });

      const endpoints = await getActiveEndpoints(pool, connection.id);
      if (endpoints.length === 0) {
        connLog.warn('No active endpoints for ERP connection — skipping');
        continue;
      }

      for (const endpoint of endpoints) {
        const pairLog = connLog.child({ endpointId: endpoint.id, path: endpoint.path });

        // Guard: skip this endpoint if no field_mappings are configured
        const fieldMappings = await getFieldMappings(pool, tenant.id, endpoint.id);
        if (fieldMappings.length === 0) {
          pairLog.warn('No field_mappings configured for endpoint — skipping');
          continue;
        }

        const eventMappings = await getEventMappings(pool, tenant.id, endpoint.id);

        let adapter;
        try {
          adapter = createAdapter(connection.erp_name, connection, endpoint);
        } catch (err) {
          pairLog.error(
            { error: err instanceof Error ? err.message : String(err) },
            'Failed to create adapter for endpoint — skipping',
          );
          continue;
        }

        const context: TenantErpContext = {
          tenant,
          connection,
          endpoint,
          adapter,
          fieldMappings,
          eventMappings,
          avimusApiToken,
        };

        pairLog.info('Starting sync cycle for endpoint');

        try {
          await runSyncCycle(pool, context, signal);
        } catch (err) {
          pairLog.error(
            { error: err instanceof Error ? err.message : String(err) },
            'Sync cycle failed for endpoint — continuing to next',
          );
        }
      }
    }
  }

  logger.info({ count: tenants.length }, 'Multi-tenant sync cycle finished');
}
