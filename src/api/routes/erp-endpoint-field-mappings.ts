import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { getTenantById } from '../../db/queries/tenants.js';
import { getEndpointById } from '../../db/queries/erp-endpoints.js';
import { getFieldMappings, replaceFieldMappings } from '../../db/queries/field-mappings.js';
import type { FieldMappingInput } from '../../db/queries/field-mappings.js';
import { getEventMappings } from '../../db/queries/event-mappings.js';
import { assertCompleteStepFieldsPresent, MissingCompleteStepFieldsError } from '../../services/mapping-validation.js';

export async function erpEndpointFieldMappingRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;
  const base = '/tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/field-mappings';

  fastify.get(base, async (request, reply) => {
    const { tenantId, connId, endpointId } = request.params as { tenantId: string; connId: string; endpointId: string };
    const tenant = await getTenantById(pool, tenantId);
    if (!tenant) { await reply.code(404).send({ error: 'Tenant not found' }); return; }

    const endpoint = await getEndpointById(pool, tenantId, connId, endpointId);
    if (!endpoint) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }

    const mappings = await getFieldMappings(pool, tenantId, endpointId);
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

    const inputs: FieldMappingInput[] = [];
    for (const m of body.mappings as unknown[]) {
      if (
        typeof m !== 'object' ||
        m === null ||
        typeof (m as Record<string, unknown>).source_field !== 'string' ||
        typeof (m as Record<string, unknown>).target_field !== 'string'
      ) {
        await reply.code(400).send({ error: 'Each mapping requires source_field and target_field strings' });
        return;
      }
      const item = m as Record<string, unknown>;
      inputs.push({
        source_field: item.source_field as string,
        target_field: item.target_field as string,
        transform: typeof item.transform === 'string' ? item.transform : null,
      });
    }

    try {
      const currentEventMappings = await getEventMappings(pool, tenantId, endpointId);
      assertCompleteStepFieldsPresent(inputs, currentEventMappings);

      const mappings = await replaceFieldMappings(pool, tenantId, endpointId, inputs);
      await reply.send({ endpoint_id: endpointId, mappings });
    } catch (err) {
      if (err instanceof MissingCompleteStepFieldsError) {
        await reply.code(422).send({ error: err.message, missingFields: err.missingFields });
        return;
      }
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) { await reply.code(404).send({ error: 'Endpoint not found' }); return; }
      throw err;
    }
  });
}
