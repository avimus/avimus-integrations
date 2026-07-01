# Data Model: Worker Multi-tenant

**Branch**: `002-worker-multi-tenant` | **Date**: 2026-06-30

---

## New Tables

### `tenants`

Represents a hospital or clinic client. One row per client.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, default `gen_random_uuid()` | |
| `name` | `TEXT` | NOT NULL | Human-readable (e.g., "Hospital São Lucas") |
| `slug` | `TEXT` | NOT NULL, UNIQUE | URL-safe identifier (e.g., "hospital-sao-lucas") |
| `is_active` | `BOOLEAN` | NOT NULL, default `true` | `false` = excluded from all sync cycles |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |

**Indexes**: none beyond PK and UNIQUE(slug).

---

### `erp_connections`

Configures one ERP instance per tenant. A tenant may have multiple rows (one per ERP type).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, default `gen_random_uuid()` | |
| `tenant_id` | `UUID` | NOT NULL, FK → `tenants(id)` | |
| `erp_name` | `TEXT` | NOT NULL | e.g., `'tasy'`, `'totvs'` |
| `base_url` | `TEXT` | NOT NULL | ERP HTTP endpoint root |
| `timeout_ms` | `INTEGER` | NOT NULL, default `10000` | Per-request timeout |
| `credentials` | `TEXT` | NULLABLE | AES-256 encrypted JSON string |
| `is_active` | `BOOLEAN` | NOT NULL, default `true` | `false` = skipped by cron |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |

**Indexes**:
- `idx_erp_connections_active` ON `(tenant_id)` WHERE `is_active = true`

**Notes**:
- `credentials` column is `TEXT`, not `JSONB`. The application encrypts the JSON-serialized
  credential object before storage and decrypts on read using `src/lib/crypto.ts`.
- Typical credential fields (not stored in DB schema — application-defined by adapter):
  `{ apiToken?: string, username?: string, password?: string }`

---

### `field_mappings`

Maps an ERP field name to a canonical target field name, per tenant + ERP combination.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, default `gen_random_uuid()` | |
| `tenant_id` | `UUID` | NOT NULL, FK → `tenants(id)` | |
| `erp_name` | `TEXT` | NOT NULL | |
| `source_field` | `TEXT` | NOT NULL | Field name in the raw ERP payload |
| `target_field` | `TEXT` | NOT NULL | Canonical field name the worker expects |
| `transform` | `TEXT` | NULLABLE | Reserved; NOT evaluated in this version |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |

**Unique constraint**: `UNIQUE(tenant_id, erp_name, source_field)` — one mapping per source
field per tenant+ERP.

**Indexes**:
- `idx_field_mappings_lookup` ON `(tenant_id, erp_name)`

**Canonical target_field values** recognized by the transformer:

| `target_field` | Required | Description |
|----------------|----------|-------------|
| `cpf` | Yes | Patient CPF — mandatory for matching |
| `eventDate` | Yes | Event date (ISO-parseable string) — mandatory |
| `erpEventCode` | Yes | ERP event code — used for event_mappings lookup |
| _(any other)_ | No | Written into outbox payload as context metadata |

---

### `event_mappings`

Maps an ERP-specific event code to an Ávimus `integrationEventId`, per tenant + ERP.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, default `gen_random_uuid()` | |
| `tenant_id` | `UUID` | NOT NULL, FK → `tenants(id)` | |
| `erp_name` | `TEXT` | NOT NULL | |
| `erp_event_code` | `TEXT` | NOT NULL | Event code as returned by the ERP |
| `avimus_event_id` | `TEXT` | NOT NULL | `integrationEventId` value in Ávimus |
| `description` | `TEXT` | NULLABLE | Human-readable note |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |

**Unique constraint**: `UNIQUE(tenant_id, erp_name, erp_event_code)`.

**Indexes**:
- `idx_event_mappings_lookup` ON `(tenant_id, erp_name)`

---

## Modified Tables

### `sync_state` (schema change)

**Before**: Single-tenant; `erp_name TEXT PRIMARY KEY`.

**After**: Multi-tenant; new `id UUID` PK, composite unique key `(tenant_id, erp_name)`.

| Column | Type | Change | Notes |
|--------|------|--------|-------|
| `id` | `UUID` | **NEW** — becomes PK | `DEFAULT gen_random_uuid()` |
| `erp_name` | `TEXT` | unchanged | |
| `last_synced_at` | `TIMESTAMPTZ` | unchanged | |
| `tenant_id` | `UUID` | **NEW** — nullable | FK → `tenants(id)`; NULL = legacy row |
| `created_at` | `TIMESTAMPTZ` | unchanged | |
| `updated_at` | `TIMESTAMPTZ` | unchanged | |

**Migration steps**:
1. `ALTER TABLE sync_state ADD COLUMN id UUID DEFAULT gen_random_uuid() NOT NULL`
2. `ALTER TABLE sync_state DROP CONSTRAINT sync_state_pkey`
3. `ALTER TABLE sync_state ADD PRIMARY KEY (id)`
4. `ALTER TABLE sync_state ADD COLUMN tenant_id UUID REFERENCES tenants(id)`
5. `CREATE UNIQUE INDEX idx_sync_state_tenant_erp ON sync_state(tenant_id, erp_name) WHERE tenant_id IS NOT NULL`
6. `CREATE UNIQUE INDEX idx_sync_state_legacy_erp ON sync_state(erp_name) WHERE tenant_id IS NULL`

**Query pattern change**:
- Old: `WHERE erp_name = $1`
- New (tenant-scoped): `WHERE tenant_id = $1 AND erp_name = $2`
- UPSERT via SELECT-then-INSERT/UPDATE (partial index cannot be targeted by ON CONFLICT clause name)

---

### `outbox` (column added)

| Column | Type | Change | Notes |
|--------|------|--------|-------|
| `tenant_id` | `UUID` | **NEW** — nullable | FK → `tenants(id)`; NULL = legacy row |

**Migration**: `ALTER TABLE outbox ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id)`

**New index**: `CREATE INDEX idx_outbox_tenant ON outbox(tenant_id) WHERE tenant_id IS NOT NULL`

**Application enforcement**: `EnqueueInput` gains mandatory `tenantId: string` field.
The `enqueue()` function includes it in the INSERT. Application layer rejects `tenantId = null`.

---

### `audit_log` (column added)

| Column | Type | Change | Notes |
|--------|------|--------|-------|
| `tenant_id` | `UUID` | **NEW** — nullable | FK → `tenants(id)`; NULL = legacy row |

**Migration**: `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id)`

**New index**: `CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id) WHERE tenant_id IS NOT NULL`

**Application enforcement**: `AuditEntry` gains optional `tenantId?: string` field.
All calls from multi-tenant code paths MUST supply it.

---

## TypeScript Interface Changes

### Removed: `RawEvent`

```typescript
// REMOVED from src/adapters/types.ts
interface RawEvent {
  eventId: string;
  cpf: string;           // hardcoded field — replaced by field_mappings
  erpEventCode: string;  // hardcoded field — replaced by event_mappings
  eventDate: Date;       // hardcoded field — replaced by field_mappings
  payload: Record<string, unknown>;
}
```

### Added: `RawErpRecord`

```typescript
// NEW in src/adapters/types.ts
interface RawErpRecord {
  eventId: string;                       // adapter-derived stable ID (e.g., `tasy-${protocolo}`)
  rawPayload: Record<string, unknown>;   // raw ERP data, no field normalization
}
```

### Added: `TenantErpContext`

```typescript
// NEW in src/services/types.ts
interface TenantErpContext {
  tenant: Tenant;
  connection: ErpConnection;
  fieldMappings: FieldMapping[];   // pre-loaded; empty = cycle skipped for this pair
  eventMappings: EventMapping[];   // pre-loaded; unknown event code = record skipped
}
```

### Added: DB row types

```typescript
// src/db/queries/tenants.ts
interface Tenant {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: Date;
}

// src/db/queries/erp-connections.ts
interface ErpConnection {
  id: string;
  tenant_id: string;
  erp_name: string;
  base_url: string;
  timeout_ms: number;
  credentials: string | null;   // encrypted TEXT; null = no auth required
  is_active: boolean;
  created_at: Date;
}

// src/db/queries/field-mappings.ts
interface FieldMapping {
  id: string;
  tenant_id: string;
  erp_name: string;
  source_field: string;
  target_field: string;
  transform: string | null;   // NOT evaluated; stored for future use
  created_at: Date;
}

// src/db/queries/event-mappings.ts
interface EventMapping {
  id: string;
  tenant_id: string;
  erp_name: string;
  erp_event_code: string;
  avimus_event_id: string;
  description: string | null;
  created_at: Date;
}
```

---

## Entity Relationship Diagram (text)

```
tenants (1) ──────── (N) erp_connections
tenants (1) ──────── (N) field_mappings
tenants (1) ──────── (N) event_mappings
tenants (1) ──────── (N) sync_state       [tenant_id nullable]
tenants (1) ──────── (N) outbox           [tenant_id nullable]
tenants (1) ──────── (N) audit_log        [tenant_id nullable]

erp_connections: (tenant_id, erp_name) drives adapter instantiation at runtime
field_mappings:  (tenant_id, erp_name) → set of source→target field rules
event_mappings:  (tenant_id, erp_name) → set of erp_event_code→avimus_event_id rules
```
