import pino from 'pino';
import { maskCpf } from './mask.js';
import { pushLog, type LogEntry } from './log-buffer.js';
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
// Avaliado a cada write (não no import) — o dotenv pode ainda não ter
// rodado quando este módulo é carregado.
const isPretty = () => process.env.NODE_ENV === 'development';

const LEVEL_LABELS: Record<number, LogEntry['level']> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const LEVEL_COLORS: Record<string, string> = {
  trace: '\x1b[90m', // cinza
  debug: '\x1b[90m',
  info: '\x1b[36m', // ciano
  warn: '\x1b[33m', // amarelo
  error: '\x1b[31m', // vermelho
  fatal: '\x1b[31m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[90m';

// Destino customizado: cada linha JSON do pino alimenta o ring buffer
// (GET /logs na Worker API) e vai para o stdout — legível em dev,
// JSON cru em produção (para coletores de log).
const bufferedStream = {
  write(line: string) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const { level: lvl, time, msg, pid: _pid, hostname: _hostname, ...rest } = parsed;
      const label = LEVEL_LABELS[lvl as number] ?? 'info';
      const ts = new Date(time as number).toISOString();
      // Defesa em profundidade: o redact do pino (`*.cpf`) não cobre chaves
      // no nível raiz do objeto logado — sanitiza de novo antes do buffer,
      // que é exposto ao admin via GET /logs.
      const context =
        Object.keys(rest).length > 0 ? (sanitizeObj(rest) as Record<string, unknown>) : undefined;
      const safeMsg = typeof msg === 'string' ? maskCpf(msg) : '';

      pushLog({ ts, level: label, msg: safeMsg, context });

      if (isPretty()) {
        const clock = ts.slice(11, 19);
        const color = LEVEL_COLORS[label] ?? '';
        const ctx = context ? ` ${DIM}${JSON.stringify(context)}${RESET}` : '';
        process.stdout.write(
          `${DIM}${clock}${RESET} ${color}${label.toUpperCase().padEnd(5)}${RESET} ${safeMsg}${ctx}\n`,
        );
      } else {
        process.stdout.write(line);
      }
    } catch {
      process.stdout.write(line);
    }
  },
};

export const logger = pino(
  {
    level,
    redact: {
      // Cobre tanto chaves no nível raiz do objeto logado quanto um nível
      // abaixo (`*.cpf` NÃO pega `cpf` na raiz — descoberto em teste).
      paths: [
        'cpf', 'documento', 'password', 'token', 'apiToken',
        '*.cpf', '*.documento', '*.password', '*.token', '*.apiToken',
      ],
      censor: '***REDACTED***',
    },
  },
  bufferedStream,
);
