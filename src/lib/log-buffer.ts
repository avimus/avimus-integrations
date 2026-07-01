// Ring buffer em memória com as últimas linhas de log do worker, exposto
// via GET /logs na Worker API para o painel "Logs do worker" no admin do
// SaaS. Reinicia vazio a cada restart do processo — não é persistência,
// é observabilidade rápida (estilo logs da Vercel).

export interface LogEntry {
  ts: string; // ISO 8601
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  msg: string;
  context?: Record<string, unknown>;
}

const MAX_ENTRIES = 500;

const entries: LogEntry[] = [];

export function pushLog(entry: LogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function getRecentLogs(limit: number): LogEntry[] {
  return entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
}
