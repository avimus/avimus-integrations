import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export function buildAuthHook(secret: string) {
  const secretBuf = Buffer.from(secret);

  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.url === '/health') return;

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.slice(7);
    const tokenBuf = Buffer.from(token);

    let valid = false;
    if (tokenBuf.length === secretBuf.length) {
      valid = timingSafeEqual(tokenBuf, secretBuf);
    }

    if (!valid) {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}
