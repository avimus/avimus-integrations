import type { FastifyInstance } from 'fastify';
import { ACTION_METADATA } from '../../services/avimus-actions/index.js';

// Lista as ações registradas em ACTION_HANDLERS (ver
// src/services/avimus-actions/index.ts), com a rota real da API do Ávimus
// que cada uma chama. Consumida pelo admin (3002) para montar o seletor de
// "Ação" no mapeamento de eventos dinamicamente — adicionar uma ação nova
// aqui não exige nenhuma mudança no admin.
export async function avimusActionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/avimus-actions', async (_request, reply) => {
    await reply.send(Object.values(ACTION_METADATA));
  });
}
