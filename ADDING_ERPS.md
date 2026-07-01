# Adding a New ERP Adapter

This guide explains how to add support for a new ERP (e.g., TOTVS, Sankhya, Linx) to the
integration service.

> **Important**: Since Feature 002 (multi-tenant), ERP connection config lives in the
> `erp_connections` database table — not in `.env`. No environment variables are needed for
> new ERP adapters.

## Steps

### 1. Create the adapter module

Create a new directory under `src/adapters/{erp-name}/` with two files:

**`src/adapters/{erp-name}/types.ts`** — ERP-specific types:

```typescript
export interface YourErpRecord {
  // Define the shape of the ERP's API response.
  // Use the actual field names the ERP API returns — do NOT normalize them.
  // Field normalization happens via field_mappings in the database.
  protocolo: string;
  cpf_or_whatever_the_erp_calls_it: string;
  event_code_field: string;
  date_field: string;
  // ... other fields
}

export type YourErpApiResponse = YourErpRecord[];
```

**`src/adapters/{erp-name}/index.ts`** — Adapter implementation:

```typescript
import type { RawErpRecord, ErpAdapter } from '../types.js';
import { ErpAdapterError } from '../types.js';

export interface YourErpAdapterConfig {
  baseUrl: string;
  timeoutMs: number;
}

export class YourErpAdapter implements ErpAdapter {
  readonly name = 'your-erp';

  constructor(private config: YourErpAdapterConfig) {}

  async fetchRecentEvents(since: Date): Promise<RawErpRecord[]> {
    // 1. Call your ERP's API
    // 2. Return raw records — do NOT map field names here.
    //    Field normalization is handled by the transformer using field_mappings.
    // 3. Throw ErpAdapterError on failures
    //    - transient: true for 5xx, network errors
    //    - transient: false for 401, 403, 404
    return records.map((r) => ({
      eventId: `your-erp-${r.protocolo}`,
      rawPayload: { ...r }, // all raw ERP fields, as-is
    }));
  }
}
```

### 2. Register the adapter

Edit `src/config/erp-registry.ts` — add a case to `createAdapter()`:

```typescript
import { YourErpAdapter } from '../adapters/your-erp/index.js';

export function createAdapter(erpName: string, connection: ErpConnection): ErpAdapter {
  switch (erpName) {
    case 'tasy':
      return new TasyAdapter({ baseUrl: connection.base_url, timeoutMs: connection.timeout_ms });
    case 'your-erp':
      return new YourErpAdapter({ baseUrl: connection.base_url, timeoutMs: connection.timeout_ms });
    default:
      throw new Error(`Unknown ERP "${erpName}"...`);
  }
}
```

### 3. Add an erp_connections row in the database

No `.env` changes needed. Instead, insert a row into the `erp_connections` table:

```sql
INSERT INTO erp_connections (tenant_id, erp_name, base_url, timeout_ms, credentials)
VALUES (
  '<tenant_uuid>',
  'your-erp',
  'https://erp.hospital.example.com',
  10000,
  '<encrypted_credentials_json>'  -- use the app's encrypt() function
);
```

### 4. Configure field_mappings for the tenant

Tell the worker how to map ERP field names to canonical fields:

```sql
INSERT INTO field_mappings (tenant_id, erp_name, source_field, target_field)
VALUES
  ('<tenant_id>', 'your-erp', 'cpf_or_whatever',   'cpf'),       -- mandatory
  ('<tenant_id>', 'your-erp', 'event_code_field',  'erpEventCode'), -- mandatory
  ('<tenant_id>', 'your-erp', 'date_field',         'eventDate'),    -- mandatory
  ('<tenant_id>', 'your-erp', 'protocolo',          'protocolId');   -- optional context
```

### 5. Configure event_mappings for the tenant

Map ERP event codes to Ávimus `integrationEventId` values:

```sql
INSERT INTO event_mappings (tenant_id, erp_name, erp_event_code, avimus_event_id)
VALUES
  ('<tenant_id>', 'your-erp', 'YOUR_ERP_EVENT_CODE', 'avimus_event_id');
```

## What you DON'T need to change

- `src/services/poller.ts` — orchestrates via the adapter interface
- `src/services/transformer.ts` — uses field_mappings; ERP-agnostic
- `src/services/outbox-worker.ts` — delivers to Ávimus (ERP-agnostic)
- `src/services/matcher.ts` — matches via Ávimus API (ERP-agnostic)
- `src/config/index.ts` — no new env vars needed
- `.env.example` — no changes needed
- `src/lib/*` — shared utilities
- `src/db/*` — database layer

## Error classification

| HTTP Status | `transient` | Core behavior |
|-------------|-------------|---------------|
| 2xx | N/A | Success |
| 401, 403, 404 | `false` | Skip cycle, log permanent error |
| 408, 429, 5xx | `true` | Retry next cycle |
| Network error | `true` | Retry next cycle |

## Testing

Write a contract test in `tests/contract/{erp-name}-adapter.test.ts` using MSW to mock
the ERP's HTTP API. Verify that `rawPayload` contains the raw ERP field names (not
normalized names).
