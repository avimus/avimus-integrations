import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import {
  getAllTenants,
  getTenantById,
  createTenant,
  updateTenant,
} from '../../db/queries/tenants.js';

export async function tenantRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;

  fastify.get('/tenants', async (_request, reply) => {
    const tenants = await getAllTenants(pool);
    await reply.send(tenants);
  });

  fastify.post('/tenants', async (request, reply) => {
    const body = request.body as { name?: unknown; slug?: unknown };
    if (typeof body?.name !== 'string' || typeof body?.slug !== 'string') {
      await reply.code(400).send({ error: 'name and slug are required strings' });
      return;
    }

    try {
      const tenant = await createTenant(pool, { name: body.name, slug: body.slug });
      await reply.code(201).send(tenant);
    } catch (err: unknown) {
      if (isPostgresError(err) && err.code === '23505') {
        await reply.code(409).send({ error: 'Slug already exists' });
        return;
      }
      throw err;
    }
  });

  fastify.patch('/tenants/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown; is_active?: unknown; avimus_api_token?: unknown } | null;

    const input: { name?: string; is_active?: boolean; avimus_api_token?: string | null } = {};
    if (typeof body?.name === 'string') input.name = body.name;
    if (typeof body?.is_active === 'boolean') input.is_active = body.is_active;
    if (typeof body?.avimus_api_token === 'string') input.avimus_api_token = body.avimus_api_token;
    else if (body?.avimus_api_token === null) input.avimus_api_token = null;

    const tenant = await updateTenant(pool, id, input);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }
    await reply.send(tenant);
  });

  fastify.get('/tenants/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = await getTenantById(pool, id);
    if (!tenant) {
      await reply.code(404).send({ error: 'Tenant not found' });
      return;
    }
    await reply.send(tenant);
  });
}

interface PostgresError extends Error {
  code?: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  return err instanceof Error && 'code' in err;
}
