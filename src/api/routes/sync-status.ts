import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import { getSyncStatus } from '../../db/queries/sync-status.js';

export async function syncStatusRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool, config } = options;

  fastify.get('/tenants/:tenantId/sync-status', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const connections = await getSyncStatus(pool, tenantId, config.pollingIntervalMinutes);
    await reply.send({ tenant_id: tenantId, connections });
  });
}
