import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import { getConnectionById } from '../../db/queries/erp-connections.js';
import {
  getAllEndpoints,
  createEndpoint,
  updateEndpoint,
  softDeleteEndpoint,
  getEndpointById,
} from '../../db/queries/erp-endpoints.js';
import { introspectEndpoint, IntrospectionError } from '../../lib/field-introspector.js';
import { decrypt } from '../../lib/crypto.js';
import { getConfig } from '../../config/index.js';

function extractToken(credentials: string | null | undefined): string | undefined {
  if (!credentials) return undefined;
  try {
    const { encryptionKey } = getConfig();
    const plain = decrypt(credentials, encryptionKey);
    const parsed = JSON.parse(plain) as Record<string, unknown>;
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

export async function erpEndpointRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;

  // GET /tenants/:tenantId/erp-connections/:connId/endpoints
  fastify.get('/tenants/:tenantId/erp-connections/:connId/endpoints', async (request, reply) => {
    const { tenantId, connId } = request.params as { tenantId: string; connId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const connection = await getConnectionById(pool, tenantId, connId);
    if (!connection) { await reply.code(404).send({ error: 'Connection not found' }); return; }

    const endpoints = await getAllEndpoints(pool, tenantId, connId);
    await reply.send(endpoints);
  });

  // POST /tenants/:tenantId/erp-connections/:connId/endpoints
  fastify.post('/tenants/:tenantId/erp-connections/:connId/endpoints', async (request, reply) => {
    const { tenantId, connId } = request.params as { tenantId: string; connId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const body = request.body as { path?: unknown; credentials?: unknown; is_active?: unknown };
    if (typeof body?.path !== 'string' || !body.path.trim()) {
      await reply.code(400).send({ error: 'path is required and must be a non-empty string' });
      return;
    }

    try {
      const endpoint = await createEndpoint(pool, tenantId, connId, {
        connection_id: connId,
        path: body.path.trim(),
        credentials: typeof body.credentials === 'string' ? body.credentials : null,
        is_active: body.is_active !== false,
      });
      await reply.code(201).send(endpoint);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) { await reply.code(404).send({ error: 'Connection not found' }); return; }
      // Unique constraint violation = 409
      if ((err as { code?: string }).code === '23505') {
        await reply.code(409).send({ error: 'Endpoint path already exists for this connection' });
        return;
      }
      throw err;
    }
  });

  // PATCH /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId
  fastify.patch('/tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId', async (request, reply) => {
    const { tenantId, connId, endpointId } = request.params as { tenantId: string; connId: string; endpointId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const body = request.body as { path?: unknown; credentials?: unknown; is_active?: unknown };
    const input: { path?: string; credentials?: string | null; is_active?: boolean } = {};
    if (typeof body?.path === 'string') input.path = body.path.trim();
    if ('credentials' in (body ?? {})) {
      input.credentials = typeof body.credentials === 'string' ? body.credentials : null;
    }
    if (typeof body?.is_active === 'boolean') input.is_active = body.is_active;

    try {
      const endpoint = await updateEndpoint(pool, tenantId, connId, endpointId, input);
      if (!endpoint) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }
      await reply.send(endpoint);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        await reply.code(409).send({ error: 'Endpoint path already exists for this connection' });
        return;
      }
      throw err;
    }
  });

  // DELETE /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId
  fastify.delete('/tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId', async (request, reply) => {
    const { tenantId, connId, endpointId } = request.params as { tenantId: string; connId: string; endpointId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const deleted = await softDeleteEndpoint(pool, tenantId, connId, endpointId);
    if (!deleted) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }
    await reply.code(204).send();
  });

  // POST /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/introspect
  fastify.post('/tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/introspect', async (request, reply) => {
    const { tenantId, connId, endpointId } = request.params as { tenantId: string; connId: string; endpointId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const connection = await getConnectionById(pool, tenantId, connId);
    if (!connection) { await reply.code(404).send({ error: 'Connection not found' }); return; }

    const endpoint = await getEndpointById(pool, tenantId, connId, endpointId);
    if (!endpoint) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }

    const token = extractToken(endpoint.credentials) ?? extractToken(connection.credentials);
    const fetchUrl = `${connection.base_url.replace(/\/$/, '')}${endpoint.path}`;

    try {
      const fields = await introspectEndpoint({
        baseUrl: connection.base_url,
        path: endpoint.path,
        token,
      });
      await reply.send({ endpoint_id: endpoint.id, path: endpoint.path, fetch_url: fetchUrl, fields });
    } catch (err) {
      if (err instanceof IntrospectionError) {
        await reply.code(504).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
