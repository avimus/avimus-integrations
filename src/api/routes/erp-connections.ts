import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import {
  getAllConnections,
  createConnection,
  updateConnection,
  softDeleteConnection,
} from '../../db/queries/erp-connections.js';

export async function erpConnectionRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;

  fastify.get('/tenants/:tenantId/erp-connections', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }
    const connections = await getAllConnections(pool, tenantId);
    await reply.send(connections);
  });

  fastify.post('/tenants/:tenantId/erp-connections', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const body = request.body as {
      erp_name?: unknown;
      base_url?: unknown;
      timeout_ms?: unknown;
      credentials?: unknown;
    };

    if (typeof body?.erp_name !== 'string' || typeof body?.base_url !== 'string') {
      await reply.code(400).send({ error: 'erp_name and base_url are required strings' });
      return;
    }

    const connection = await createConnection(pool, {
      tenant_id: tenantId,
      erp_name: body.erp_name,
      base_url: body.base_url,
      timeout_ms: typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined,
      credentials: typeof body.credentials === 'string' ? body.credentials : undefined,
    });
    await reply.code(201).send(connection);
  });

  fastify.patch('/tenants/:tenantId/erp-connections/:id', async (request, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const body = request.body as {
      base_url?: unknown;
      timeout_ms?: unknown;
      credentials?: unknown;
      is_active?: unknown;
    };

    const connection = await updateConnection(pool, tenantId, id, {
      base_url: typeof body?.base_url === 'string' ? body.base_url : undefined,
      timeout_ms: typeof body?.timeout_ms === 'number' ? body.timeout_ms : undefined,
      credentials: typeof body?.credentials === 'string' ? body.credentials : undefined,
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : undefined,
    });

    if (!connection) {
      await reply.code(404).send({ error: 'ERP connection not found' });
      return;
    }
    await reply.send(connection);
  });

  fastify.delete('/tenants/:tenantId/erp-connections/:id', async (request, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }

    const deleted = await softDeleteConnection(pool, tenantId, id);
    if (!deleted) {
      await reply.code(404).send({ error: 'ERP connection not found' });
      return;
    }
    await reply.code(204).send();
  });
}
