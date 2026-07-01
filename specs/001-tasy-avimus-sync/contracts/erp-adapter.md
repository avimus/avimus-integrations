# ErpAdapter Interface Contract

**Date**: 2026-06-29

## Overview

This contract defines the interface that all ERP adapters MUST implement. The core pipeline depends ONLY on this contract — no ERP-specific logic exists outside adapter modules.

## Interface

```typescript
export interface RawEvent {
  /** Adapter-assigned unique ID for idempotency */
  eventId: string;
  /** Patient CPF (encrypted at rest, masked in logs) */
  cpf: string;
  /** ERP-specific event code mapped to Ávimus integration_event_id */
  erpEventCode: string;
  /** When the event occurred in the ERP */
  eventDate: Date;
  /** Normalized payload for transformer consumption */
  payload: Record<string, unknown>;
}

export interface ErpAdapter {
  /** Stable identifier used in config, logs, and sync_state table */
  readonly name: string;

  /**
   * Fetch events created/modified since `since`.
   * Responsibilities:
   * - HTTP auth (adapter-specific tokens, headers)
   * - Pagination (if the ERP paginates)
   * - Translating ERP-specific API shapes into RawEvent[]
   * - Throwing ErpAdapterError on transient failures
   */
  fetchRecentEvents(since: Date): Promise<RawEvent[]>;
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
```

## Error Classification

| HTTP Status | `transient` | Core Behavior |
|-------------|-------------|---------------|
| 2xx | N/A | Success |
| 401, 403 | `false` | Skip cycle, log permanent error |
| 404 | `false` | Skip cycle, log permanent error |
| 408, 429, 5xx | `true` | Retry next cycle (do NOT update `last_synced_at`) |
| Network error | `true` | Retry next cycle |

## Adding a New ERP Adapter

1. Create `src/adapters/{name}/index.ts` implementing `ErpAdapter`
2. Create `src/adapters/{name}/types.ts` for ERP-specific types
3. Add factory entry to `src/config/erp-registry.ts`
4. Add env vars for the new ERP
5. Zero changes to core services
