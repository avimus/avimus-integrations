import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config/index.js';
import { buildAuthHook } from './auth.js';
import { healthRoutes } from './routes/health.js';
import { tenantRoutes } from './routes/tenants.js';
import { erpConnectionRoutes } from './routes/erp-connections.js';
import { erpEndpointRoutes } from './routes/erp-endpoints.js';
import { erpEndpointFieldMappingRoutes } from './routes/erp-endpoint-field-mappings.js';
import { erpEndpointEventMappingRoutes } from './routes/erp-endpoint-event-mappings.js';
import { syncStatusRoutes } from './routes/sync-status.js';
import { outboxRoutes } from './routes/outbox.js';
import { avimusActionRoutes } from './routes/avimus-actions.js';

export async function buildApiServer(pool: Pool, config: Config): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['*.cpf', '*.documento', '*.password', '*.token'],
        censor: '***REDACTED***',
      },
    },
  });

  fastify.addHook('onRequest', buildAuthHook(config.workerApiSecret));

  fastify.setErrorHandler(async (error: { statusCode?: number; message?: string }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    await reply.code(statusCode).send({ error: error.message ?? 'Internal Server Error' });
  });

  await fastify.register(healthRoutes, { pool, config });
  await fastify.register(tenantRoutes, { pool, config });
  await fastify.register(erpConnectionRoutes, { pool, config });
  await fastify.register(erpEndpointRoutes, { pool, config });
  await fastify.register(erpEndpointFieldMappingRoutes, { pool, config });
  await fastify.register(erpEndpointEventMappingRoutes, { pool, config });
  await fastify.register(syncStatusRoutes, { pool, config });
  await fastify.register(outboxRoutes, { pool, config });
  await fastify.register(avimusActionRoutes);

  return fastify;
}
