export interface RawErpRecord {
  eventId: string;                     // adapter-derived stable ID (e.g., `tasy-${protocolo}`)
  rawPayload: Record<string, unknown>; // raw ERP data; no field normalization
}

export interface ErpAdapter {
  readonly name: string;
  fetchRecentEvents(since: Date): Promise<RawErpRecord[]>;
}

export class ErpAdapterError extends Error {
  constructor(
    message: string,
    public readonly adapterName: string,
    public readonly transient: boolean,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ErpAdapterError';
  }
}
