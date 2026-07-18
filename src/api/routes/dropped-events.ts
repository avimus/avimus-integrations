import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import { listDroppedEvents } from '../../db/queries/dropped-events.js';

export async function droppedEventsRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;

  fastify.get('/tenants/:tenantId/dropped-events', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const query = request.query as { limit?: string; cursor?: string };

    const rawLimit = parseInt(query.limit ?? '20', 10);
    if (isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      await reply.code(400).send({ error: 'limit must be an integer between 1 and 100' });
      return;
    }

    const page = await listDroppedEvents(pool, { tenantId, limit: rawLimit, cursor: query.cursor });
    await reply.send(page);
  });
}
