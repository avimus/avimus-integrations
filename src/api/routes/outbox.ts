import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import { listOutbox, retryOutboxRecord } from '../../db/queries/outbox.js';

export async function outboxRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;

  fastify.get('/tenants/:tenantId/outbox', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const query = request.query as {
      status?: string;
      date?: string;
      limit?: string;
      cursor?: string;
    };

    const rawLimit = parseInt(query.limit ?? '20', 10);
    if (isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      await reply.code(400).send({ error: 'limit must be an integer between 1 and 100' });
      return;
    }

    const validStatuses = ['pendente', 'enviado', 'falhou'];
    if (query.status && !validStatuses.includes(query.status)) {
      await reply.code(400).send({ error: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const page = await listOutbox(pool, {
      tenantId,
      status: query.status as 'pendente' | 'enviado' | 'falhou' | undefined,
      date: query.date,
      limit: rawLimit,
      cursor: query.cursor,
    });

    await reply.send(page);
  });

  fastify.post('/tenants/:tenantId/outbox/:id/retry', async (request, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const retried = await retryOutboxRecord(pool, tenantId, id);
    if (!retried) {
      await reply.code(409).send({ error: "Retry only allowed for records with status 'falhou'" });
      return;
    }

    await reply.send({ id, status: 'pendente', attempt_count: 0 });
  });
}
