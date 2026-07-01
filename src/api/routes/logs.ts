import type { FastifyInstance } from 'fastify';
import { getRecentLogs } from '../../lib/log-buffer.js';

// Últimas linhas de log do worker (ring buffer em memória — ver
// src/lib/log-buffer.ts). Consumida pelo painel "Logs do worker" no admin
// do SaaS. CPFs já chegam mascarados aqui (sanitização no logger).
export async function logRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/logs', async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const parsed = Number(limit ?? '100');
    await reply.send({ data: getRecentLogs(Number.isFinite(parsed) && parsed > 0 ? parsed : 100) });
  });
}
