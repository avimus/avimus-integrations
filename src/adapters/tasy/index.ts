import type { RawErpRecord, ErpAdapter } from '../types.js';
import { ErpAdapterError } from '../types.js';
import { unwrapRecordArray } from '../../lib/unwrap-records.js';

export interface TasyAdapterConfig {
  baseUrl: string;
  path: string;
  timeoutMs: number;
  token?: string;
}

export class TasyAdapter implements ErpAdapter {
  readonly name = 'tasy';
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;

  constructor(config: TasyAdapterConfig) {
    this.baseUrl = config.baseUrl;
    this.path = config.path;
    this.timeoutMs = config.timeoutMs;
    this.token = config.token;
  }

  async fetchRecentEvents(since: Date): Promise<RawErpRecord[]> {
    try {
      const url = new URL(this.path, this.baseUrl);
      url.searchParams.set('since', since.toISOString());

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url.toString(), {
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          const transient = this.isTransientError(response.status);
          throw new ErpAdapterError(
            `Tasy API returned ${response.status}: ${response.statusText}`,
            this.name,
            transient,
          );
        }

        const data: unknown = await response.json();
        // A resposta pode vir como array puro ou embrulhada numa chave (ex.:
        // `{ atendimentos: [...], data_consulta: "..." }`) — ver unwrap-records.ts.
        const records = unwrapRecordArray(data);
        if (!records) {
          throw new ErpAdapterError(
            'Tasy API response does not contain a recognizable list of records',
            this.name,
            false,
          );
        }
        return records.map((record) => this.mapToRawErpRecord(record));
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof ErpAdapterError) throw err;

      throw new ErpAdapterError(
        `Tasy API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
        true,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private mapToRawErpRecord(record: Record<string, unknown>): RawErpRecord {
    // eventId é usado só para rastreamento/log (não é chave de deduplicação —
    // isso é feito por hasRecentSuccess/checkActiveJourney com base no
    // payload já transformado). Tenta alguns nomes de campo comuns de
    // identificador antes de cair num sufixo aleatório.
    const idLike =
      record.protocolo ?? record.CD_PROTOCOLO ?? record.NR_ATENDIMENTO ?? record.protocolId ?? Math.random().toString(36).slice(2);
    return {
      eventId: `tasy-${this.path}-${idLike}`,
      rawPayload: { ...record },
    };
  }

  private isTransientError(status: number): boolean {
    return [408, 429, 500, 502, 503, 504].includes(status);
  }
}
