import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import { getEndpointById } from '../../db/queries/erp-endpoints.js';
import { getEventMappings, replaceEventMappings } from '../../db/queries/event-mappings.js';
import type { EventMappingInput } from '../../db/queries/event-mappings.js';
import { ACTION_METADATA } from '../../services/avimus-actions/index.js';

// Derivado de ACTION_METADATA (não hardcoded) — adicionar uma ação nova só
// nesse registro já é suficiente pra ela ser aceita aqui também.
const VALID_ACTIONS = new Set(Object.keys(ACTION_METADATA));

export async function erpEndpointEventMappingRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;
  const base = '/tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/event-mappings';

  fastify.get(base, async (request, reply) => {
    const { tenantId, connId, endpointId } = request.params as { tenantId: string; connId: string; endpointId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const endpoint = await getEndpointById(pool, tenantId, connId, endpointId);
    if (!endpoint) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }

    const mappings = await getEventMappings(pool, tenantId, endpointId);
    await reply.send({ endpoint_id: endpointId, mappings });
  });

  fastify.put(base, async (request, reply) => {
    const { tenantId, endpointId } = request.params as { tenantId: string; connId: string; endpointId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const body = request.body as { mappings?: unknown };
    if (!Array.isArray(body?.mappings)) {
      await reply.code(400).send({ error: 'mappings must be an array' });
      return;
    }

    const inputs: EventMappingInput[] = [];
    for (const m of body.mappings as unknown[]) {
      if (typeof m !== 'object' || m === null) {
        await reply.code(400).send({ error: 'Each mapping must be an object' });
        return;
      }
      const item = m as Record<string, unknown>;

      if (typeof item.erp_event_code !== 'string') {
        await reply.code(400).send({ error: 'Each mapping requires erp_event_code string' });
        return;
      }
      if (!VALID_ACTIONS.has(item.avimus_action as string)) {
        await reply.code(400).send({ error: `avimus_action must be one of: ${[...VALID_ACTIONS].join(', ')}` });
        return;
      }
      if (item.avimus_action === 'complete_step' && typeof item.avimus_event_id !== 'string') {
        await reply.code(400).send({ error: 'avimus_event_id is required for complete_step action' });
        return;
      }

      inputs.push({
        erp_event_code: item.erp_event_code as string,
        avimus_event_id: typeof item.avimus_event_id === 'string' ? item.avimus_event_id : null,
        avimus_action: item.avimus_action as 'complete_step' | 'start_journey',
        description: typeof item.description === 'string' ? item.description : null,
      });
    }

    try {
      const mappings = await replaceEventMappings(pool, tenantId, endpointId, inputs);
      await reply.send({ endpoint_id: endpointId, mappings });
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }
      throw err;
    }
  });
}
