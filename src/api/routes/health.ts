import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';

export async function healthRoutes(
  fastify: FastifyInstance,
  options: { pool: Pool; config: Config },
): Promise<void> {
  const { pool } = options;

  fastify.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      await reply.code(200).send({
        status: 'ok',
        database: 'connected',
        uptime_seconds: Math.floor(process.uptime()),
      });
    } catch (err) {
      await reply.code(503).send({
        status: 'degraded',
        database: 'disconnected',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
