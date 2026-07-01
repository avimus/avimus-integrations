# Research: Worker Multi-tenant

**Branch**: `002-worker-multi-tenant` | **Date**: 2026-06-30

## 1. Adapter Interface Change — RawErpRecord vs RawEvent

**Decision**: Change `ErpAdapter.fetchRecentEvents()` return type from `RawEvent[]` to
`RawErpRecord[]`. A `RawErpRecord` carries only `eventId` (adapter-derived) and
`rawPayload: Record<string, unknown>` (the ERP data verbatim, no field normalization).

**Rationale**: The current `mapToRawEvent()` in `TasyAdapter` hardcodes field names
(`record.cpf`, `record.evento_codigo`, `record.data_atendimento`). Different tenants may
have different field names for the same concept (e.g., `codigo_pessoa_fisica` vs `cpf` for
patient identifier). Moving field-name normalization out of the adapter and into the
transformer (driven by `field_mappings`) is the only way to satisfy Principle VII
(Configuration over Code) and FR-007.

**Alternatives considered**:
- Keep `RawEvent` and add field name config per adapter — rejected: the adapter would still
  need to know the tenant's field names, creating a coupling between adapter and tenant data.
- Keep `RawEvent` and use field_mappings only for the `payload` extras — rejected: the
  `cpf` and `erpEventCode` fields in `RawEvent` are themselves the hardcoded problem.

**Impact**: `TasyAdapter.mapToRawEvent()` renamed to `mapToRawErpRecord()`. Returns raw
`TasyAtendimento` data spread into `rawPayload`. Adapter becomes truly field-agnostic.

---

## 2. Transformer Responsibility Expansion

**Decision**: The transformer becomes the single point of field-name resolution. It receives
`rawPayload` + `fieldMappings` and derives the canonical set of values (`cpf`, `eventDate`,
`erpEventCode`) needed for matching and enqueuing. Event code resolution (via `eventMappings`)
also happens in the transformer before the matcher is called.

**Rationale**: The transformer is the natural owner of "ERP data → canonical payload"
conversion. Previously it assumed normalized input; now it derives canonical values from raw
data using configuration. The matcher remains unchanged in responsibility — it only receives
already-resolved Ávimus identifiers.

**Canonical target fields** (the `target_field` values the transformer recognizes):
- `cpf` — patient identifier, mandatory
- `eventDate` — event date string (ISO-parseable), mandatory
- `erpEventCode` — the ERP event code used for event_mappings lookup, mandatory

All other field mappings (`protocolId`, etc.) are written into the outbox payload as
additional context but are not required for matching.

---

## 3. event_mappings Lookup Position

**Decision**: Event code resolution (erp_event_code → avimus_event_id) happens inside the
transformer, not the matcher. The transformer hands a resolved `avimusEventId` to the matcher.

**Rationale**: The matcher's job is Ávimus API traversal (patient → journey → step). It
should not know about ERP event codes. Moving resolution to the transformer keeps concerns
separated and makes the matcher's input type-safe (it always receives an already-resolved
Ávimus identifier).

**Alternatives considered**:
- Resolve in matcher — rejected: matcher would need access to event_mappings, coupling it to
  tenant data.
- Resolve in poller — rejected: pollutes orchestration with transformation logic.

---

## 4. sync_state Primary Key Migration

**Decision**: Change `sync_state` PK from `erp_name TEXT` to a composite unique key on
`(tenant_id, erp_name)`, implemented as:
1. Add `id UUID DEFAULT gen_random_uuid()` column
2. Drop current `erp_name` PK constraint
3. Add `id` as new PK
4. Add partial unique index `ON sync_state(tenant_id, erp_name) WHERE tenant_id IS NOT NULL`
5. Add partial unique index `ON sync_state(erp_name) WHERE tenant_id IS NULL` (preserves
   legacy single-tenant row uniqueness)

**Rationale**: The current PK makes it impossible to store separate sync state for the same
ERP across multiple tenants (e.g., two hospitals both using Tasy). The new composite key
allows per-tenant sync state. Legacy rows (NULL tenant_id) are preserved without conflict.

**Application-layer UPSERT**: Since partial unique indexes cannot be named for ON CONFLICT,
the `updateSyncState` function uses a SELECT + conditional INSERT/UPDATE pattern instead of a
single UPSERT. This adds one extra round-trip but avoids index naming complexity.

---

## 5. credentials Encryption in erp_connections

**Decision**: Store `erp_connections.credentials` as an AES-256-encrypted string (same
mechanism used for `outbox.aggregate_id`). The `credentials` column type is `TEXT` (not
`JSONB`) at the storage layer — the application encrypts the JSON string before storage and
decrypts on read.

**Rationale**: The existing `crypto.ts` module handles `encrypt(string, key)` /
`decrypt(string, key)`. Reusing it is consistent with Principle III (Simplicity) and the
existing pattern. JSONB at the storage layer would require decryption before PostgreSQL could
parse the JSON, so TEXT is the right column type.

**Column in migration**: `credentials TEXT` (not `JSONB`). The application deserializes after
decryption.

---

## 6. Config Env Var Removals

**Decision**: Remove `TASY_BASE_URL`, `TASY_TIMEOUT_MS`, and `ERP_NAMES` from the Zod config
schema. These move to the `erp_connections` table.

**Rationale**: ERP connection parameters are now tenant-scoped and live in the database
(Principle VII). The env-var-driven single-tenant config is the root cause of the hardcoding
problem this feature exists to solve.

**Migration note**: Deployments must be re-provisioned after this feature: the env vars are
removed, and a seed script must populate `tenants` and `erp_connections` before the worker
starts. The `.env.example` file must be updated to remove these vars and document the seeding
requirement.

---

## 7. Single Cron — Multi-tenant Orchestrator

**Decision**: Replace the per-adapter cron jobs with a single cron task that calls a new
`runMultiTenantSyncCycle(pool, signal)` function. This function:
1. Queries `getActiveTenants(pool)` — ordered by `created_at ASC`
2. For each tenant, queries `getActiveConnections(pool, tenant.id)` — ordered by `created_at ASC`
3. Checks `getFieldMappings(pool, tenant.id, connection.erp_name)` — skips with WARN if empty
4. Loads `getEventMappings(pool, tenant.id, connection.erp_name)`
5. Creates the adapter from `connection` via `createAdapter(connection.erp_name, connection)`
6. Calls `runSyncCycle(pool, context, signal)` sequentially

**Lock**: One PostgreSQL advisory lock (`JOB_LOCKS.SYNC_CYCLE`) covers the entire
multi-tenant loop. This replaces the per-adapter lock strategy.

**Rationale**: Sequential processing (confirmed in clarification) means one lock is
sufficient. Multiple locks would only help with parallel processing, which is out of scope.

---

## 8. Testing Strategy

**Decision**: Use `vitest` + `msw` (already in devDependencies) for:
- Unit tests on transformer: mock fieldMappings + eventMappings, assert canonical extraction
- Unit tests on matcher: unchanged
- Integration tests on query functions: use a test PostgreSQL database seeded with fixtures

**No new test dependencies needed.** The existing `vitest` + `msw` setup covers all scenarios.

---

## 9. No New Dependencies

All requirements are satisfiable with the existing stack:
- Multi-tenant DB queries: `pg` (parameterized queries with tenant_id)
- Credential encryption: existing `src/lib/crypto.ts`
- Logging with tenant context: `pino` child loggers with `{ tenantId }` binding
- Schema validation of DB results: `zod` parse on query rows
- Migrations: raw SQL files loaded by `src/db/migrate.ts`
