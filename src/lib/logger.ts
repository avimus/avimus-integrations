import pino from 'pino';
import { maskCpf } from './mask.js';
export { maskCpf } from './mask.js';

function sanitizeObj(obj: unknown): unknown {
  if (typeof obj === 'string') return maskCpf(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObj);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (/cpf|documento|document/i.test(k) && typeof v === 'string') {
          return [k, '***REDACTED***'];
        }
        return [k, sanitizeObj(v)];
      }),
    );
  }
  return obj;
}

export function safeLog(obj: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObj(obj) as Record<string, unknown>;
}

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  redact: {
    paths: ['*.cpf', '*.documento', '*.password', '*.token', '*.apiToken'],
    censor: '***REDACTED***',
  },
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined,
});
