---
description: "Task list for Feature 002 — Worker Multi-tenant"
---

# Tasks: Worker Multi-tenant

**Input**: Design documents from `specs/002-worker-multi-tenant/`

**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ quickstart.md ✅

**Tests**: Not explicitly requested — no test tasks generated. See `quickstart.md` for
manual validation checkpoints.

**Organization**: Tasks are grouped by user story to enable independent implementation and
testing of each story.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths are included in every description

---

## Phase 1: Setup

**Purpose**: Update configuration artifacts before any code changes begin.

- [x] T001 Update `.env.example` — remove `TASY_BASE_URL`, `TASY_TIMEOUT_MS`, `ERP_NAMES`; add comment block explaining these now live in the `erp_connections` table and reference `quickstart.md` for the seed script

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema, TypeScript interfaces, query modules, adapter contract, and
config cleanup. ALL user story work is blocked until this phase is complete.

**⚠️ CRITICAL**: No user story work can begin until this phase completes.

### Migration

- [x] T002 Create `src/db/migrations/002_multi_tenant.sql` implementing the full schema change
  from `data-model.md`:
  - `CREATE TABLE IF NOT EXISTS tenants (id UUID PK, name TEXT, slug TEXT UNIQUE, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ)`
  - `CREATE TABLE IF NOT EXISTS erp_connections (id UUID PK, tenant_id UUID FK→tenants, erp_name TEXT, base_url TEXT, timeout_ms INT DEFAULT 10000, credentials TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ)` + index `ON (tenant_id) WHERE is_active = true`
  - `CREATE TABLE IF NOT EXISTS field_mappings (id UUID PK, tenant_id UUID FK→tenants, erp_name TEXT, source_field TEXT, target_field TEXT, transform TEXT, created_at TIMESTAMPTZ, UNIQUE(tenant_id, erp_name, source_field))` + index `ON (tenant_id, erp_name)`
  - `CREATE TABLE IF NOT EXISTS event_mappings (id UUID PK, tenant_id UUID FK→tenants, erp_name TEXT, erp_event_code TEXT, avimus_event_id TEXT, description TEXT, created_at TIMESTAMPTZ, UNIQUE(tenant_id, erp_name, erp_event_code))` + index `ON (tenant_id, erp_name)`
  - `ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid() NOT NULL`; `ALTER TABLE sync_state DROP CONSTRAINT sync_state_pkey`; `ALTER TABLE sync_state ADD PRIMARY KEY (id)`; `ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id)`
  - `CREATE UNIQUE INDEX idx_sync_state_tenant_erp ON sync_state(tenant_id, erp_name) WHERE tenant_id IS NOT NULL`
  - `CREATE UNIQUE INDEX idx_sync_state_legacy_erp ON sync_state(erp_name) WHERE tenant_id IS NULL`
  - `ALTER TABLE outbox ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id)` + index `ON outbox(tenant_id) WHERE tenant_id IS NOT NULL`
  - `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id)` + index `ON audit_log(tenant_id) WHERE tenant_id IS NOT NULL`

### New Query Modules (parallel after T002)

- [x] T003 [P] Create `src/db/queries/tenants.ts` — export `Tenant` interface (`id`, `name`, `slug`, `is_active`, `created_at`); export `getActiveTenants(pool: Pool): Promise<Tenant[]>` querying `SELECT * FROM tenants WHERE is_active = true ORDER BY created_at ASC`

- [x] T004 [P] Create `src/db/queries/erp-connections.ts` — export `ErpConnection` interface (`id`, `tenant_id`, `erp_name`, `base_url`, `timeout_ms`, `credentials: string | null`, `is_active`, `created_at`); export `getActiveConnections(pool: Pool, tenantId: string): Promise<ErpConnection[]>` querying `WHERE tenant_id = $1 AND is_active = true ORDER BY created_at ASC`

- [x] T005 [P] Create `src/db/queries/field-mappings.ts` — export `FieldMapping` interface (`id`, `tenant_id`, `erp_name`, `source_field`, `target_field`, `transform: string | null`, `created_at`); export `getFieldMappings(pool: Pool, tenantId: string, erpName: string): Promise<FieldMapping[]>` querying `WHERE tenant_id = $1 AND erp_name = $2 ORDER BY source_field ASC`

- [x] T006 [P] Create `src/db/queries/event-mappings.ts` — export `EventMapping` interface (`id`, `tenant_id`, `erp_name`, `erp_event_code`, `avimus_event_id`, `description: string | null`, `created_at`); export `getEventMappings(pool: Pool, tenantId: string, erpName: string): Promise<EventMapping[]>` querying `WHERE tenant_id = $1 AND erp_name = $2 ORDER BY erp_event_code ASC`

### Existing Query Module Updates (parallel after T002)

- [x] T007 [P] Update `src/db/queries/sync-state.ts` — change `getLastSyncedAt(pool, erpName)` to `getLastSyncedAt(pool, tenantId: string, erpName: string)` using `WHERE tenant_id = $1 AND erp_name = $2`; change `updateSyncState(pool, erpName, timestamp)` to `updateSyncState(pool, tenantId: string, erpName: string, timestamp: Date)` using SELECT-then-INSERT/UPDATE pattern (SELECT to check existence, then INSERT if missing or UPDATE if present) targeting `WHERE tenant_id = $1 AND erp_name = $2`

- [x] T008 [P] Update `src/db/queries/outbox.ts` — add `tenantId: string` to `EnqueueInput` interface; add `tenant_id` column to the INSERT in `enqueue()` (pass `input.tenantId`); add `tenant_id: string | null` to `OutboxRecord` interface

- [x] T009 [P] Update `src/db/queries/audit-log.ts` — add optional `tenantId?: string` to `AuditEntry` interface; add `tenant_id` column to INSERT in `logAudit()` passing `entry.tenantId ?? null`

### Adapter Interface Change (parallel with T007–T009)

- [x] T010 [P] Update `src/adapters/types.ts` — remove `RawEvent` interface entirely; add `RawErpRecord = { eventId: string; rawPayload: Record<string, unknown> }`; change `ErpAdapter` interface: `fetchRecentEvents(since: Date): Promise<RawErpRecord[]>`

- [x] T011 Update `src/adapters/tasy/index.ts` — rename `mapToRawEvent` to `mapToRawErpRecord`; update return type to `RawErpRecord`; implementation: `return { eventId: \`tasy-\${record.protocolo}\`, rawPayload: { ...record } }` — the adapter no longer references specific field names like `record.cpf` or `record.evento_codigo` in the return value (depends on T010)

### Service Types

- [x] T012 [P] Create `src/services/types.ts` — export `TenantErpContext` interface: `{ tenant: Tenant; connection: ErpConnection; adapter: ErpAdapter; fieldMappings: FieldMapping[]; eventMappings: EventMapping[] }` (import types from their respective query modules and from `src/adapters/types.ts`)

### Config Cleanup (parallel with each other)

- [x] T013 [P] Update `src/config/index.ts` — remove `tasyBaseUrl` (`TASY_BASE_URL`), `tasyTimeoutMs` (`TASY_TIMEOUT_MS`), `erpNames` (`ERP_NAMES`) from the Zod `ConfigSchema`; update the `Config` type accordingly; these fields no longer exist in the config object

- [x] T014 [P] Update `src/config/erp-registry.ts` — remove `resolveActiveAdapters(config)` export; add `createAdapter(erpName: string, connection: ErpConnection): ErpAdapter` that constructs the right adapter from `connection.base_url` and `connection.timeout_ms`; `TasyAdapter` case: `new TasyAdapter({ baseUrl: connection.base_url, timeoutMs: connection.timeout_ms })`; throw for unknown `erpName`

**Checkpoint**: `npm run typecheck` must pass zero errors. Migration file exists and runs
via `npm run db:migrate`. All new type interfaces compile.

---

## Phase 3: User Story 1 — Sync Cycle Iterates Active Tenants (Priority: P1) 🎯 MVP

**Goal**: The cron processes all active `(tenant, erp_connection)` pairs sequentially in one
cycle; `tenant_id` appears on all output rows; inactive tenants and connections are skipped;
missing `field_mappings` produces a WARN log without aborting other pairs.

**Independent Test**: Run quickstart.md Validation A (two tenants → two sets of outbox rows
with correct `tenant_id`), B (inactive tenant → zero new rows), C (missing field_mappings →
WARN log, other tenant still processed).

### Implementation for User Story 1

- [x] T015 [US1] Update `src/services/matcher.ts` — rename parameter `erpEventCode` to
  `avimusEventId` in `matchStep(journeyId, avimusEventId)` and `findMatchingStep(cpf, avimusEventId)`;
  update all internal uses; the comparison `s.integrationEventId === erpEventCode` becomes
  `s.integrationEventId === avimusEventId`; add INFO log when no matching step found that
  includes `{ avimusEventId }` in context

- [x] T016 [US1] Update `src/services/transformer.ts` — rewrite `transformEvent` signature to
  `transformEvent(rawRecord: RawErpRecord, context: TenantErpContext): Promise<TransformResult | null>`:
  - Extract canonical fields via `context.fieldMappings`: for each of `'cpf'`, `'erpEventCode'`, `'eventDate'`, find the `FieldMapping` with matching `target_field`, then read `rawRecord.rawPayload[mapping.source_field]` as the value
  - If any mandatory field (`cpf`, `erpEventCode`, `eventDate`) is missing or empty → log WARN with `{ tenantId: context.tenant.id, erpName: context.connection.erp_name, missingField }` and return null
  - If `source_field` exists in mappings but key is absent from `rawPayload` → log DEBUG with `{ tenantId, erpName, sourceField }` and treat as null
  - After extracting `erpEventCode`, look up in `context.eventMappings`: find row where `erp_event_code === extractedErpEventCode`; if not found → log WARN with `{ tenantId, erpName, erpEventCode }` and return null
  - Pass resolved `avimusEventId` (from `eventMapping.avimus_event_id`) to `findMatchingStep(cpf, avimusEventId)`
  - All log entries use `safeLog()` wrapper to mask CPF values

- [x] T017 [US1] Update `src/services/poller.ts` — change `runSyncCycle(pool, adapter, signal?)` to
  `runSyncCycle(pool, context: TenantErpContext, signal?)`:
  - Replace all `adapter.name` references with `context.connection.erp_name`
  - Replace `adapter.fetchRecentEvents(since)` with `context.adapter.fetchRecentEvents(since)`
  - Pass `tenantId: context.tenant.id` to `getLastSyncedAt(pool, context.tenant.id, erpName)`, `updateSyncState(pool, context.tenant.id, erpName, fetchStartedAt)`, `enqueue(pool, { tenantId: context.tenant.id, ... })`, and `logAudit(pool, { tenantId: context.tenant.id, ... })`
  - Update `processEvent` to accept and forward `context: TenantErpContext`; call `transformEvent(rawRecord, context)` instead of `transformEvent({ ...event, payload: ... })`
  - Bind `{ tenantId: context.tenant.id }` to all pino log entries in this module

- [x] T018 [US1] Create `src/services/tenant-orchestrator.ts` — export
  `runMultiTenantSyncCycle(pool: Pool, signal?: AbortSignal): Promise<void>`:
  - Call `getActiveTenants(pool)` — log INFO with `{ count: tenants.length }` at start
  - For each tenant: call `getActiveConnections(pool, tenant.id)`
  - For each connection: call `getFieldMappings(pool, tenant.id, connection.erp_name)`
  - If `fieldMappings.length === 0` → `logger.warn({ tenantId: tenant.id, erpName: connection.erp_name }, 'No field_mappings configured, skipping')` and `continue`
  - Call `getEventMappings(pool, tenant.id, connection.erp_name)`
  - Instantiate `adapter` via `createAdapter(connection.erp_name, connection)`; decrypt `connection.credentials` with `decrypt(connection.credentials, config.encryptionKey)` if non-null before passing to adapter (or pass raw and let adapter handle)
  - Build `context: TenantErpContext = { tenant, connection, adapter, fieldMappings, eventMappings }`
  - Call `await runSyncCycle(pool, context, signal)` inside try/catch — on error log ERROR with `{ tenantId: tenant.id, erpName: connection.erp_name, error }` and continue to next pair
  - Log INFO with `{ tenantId: tenant.id, erpName: connection.erp_name }` before each `runSyncCycle` call

- [x] T019 [US1] Update `src/index.ts` — replace per-adapter cron loop with a single cron task:
  - Remove `resolveActiveAdapters(config)` call and the `for (const adapter of adapters)` loop
  - Add `SYNC_CYCLE: 100_001` to `JOB_LOCKS` constant in `src/lib/mutex.ts`
  - Single cron: `cron.schedule(expression, async () => { const lock = await withAdvisoryLock(pool, JOB_LOCKS.SYNC_CYCLE, () => runMultiTenantSyncCycle(pool, controller.signal)); if (!lock.acquired) logger.warn('Sync cycle skipped — previous cycle still running'); })`
  - Update startup log message from `'Starting Tasy-Ávimus Sync service'` to `'Starting Ávimus Integrations worker'`
  - Import `runMultiTenantSyncCycle` from `./services/tenant-orchestrator.js`

**Checkpoint**: At this point, User Story 1 is fully functional and independently testable.
Run quickstart.md Validation A, B, C to confirm.

---

## Phase 4: User Story 2 — Field Mappings from Database (Priority: P2)

**Goal**: Confirm transformer's field extraction handles all edge cases per spec.md and
that missing-field behavior is observable in logs.

**Independent Test**: Run quickstart.md Validation C — delete all `field_mappings` for one
tenant+ERP, confirm WARN log and no new outbox rows for that pair.

### Implementation for User Story 2

- [x] T020 [P] [US2] Verify `src/services/transformer.ts` — confirm the DEBUG log for absent
  `source_field` in `rawPayload` (when field exists in `fieldMappings` but key is missing from
  `rawPayload`) includes `{ tenantId, erpName, sourceField, targetField }` — add these fields
  to the DEBUG log call if not already present from T016

- [x] T021 [US2] Verify `src/db/queries/field-mappings.ts` — confirm `getFieldMappings` query
  returns rows with `ORDER BY source_field ASC` for deterministic transformer behavior; add the
  `ORDER BY` clause if missing from T005

**Checkpoint**: User Story 2 fully functional and testable. SC-006 (no hardcoded field names
in business logic) verified by grepping for Tasy field names in `src/services/`.

---

## Phase 5: User Story 3 — Event Mappings from Database (Priority: P3)

**Goal**: Confirm event code resolution handles unmapped codes gracefully with structured
WARN logs that include tenant context.

**Independent Test**: Insert an ERP record with an unmapped event code; confirm WARN log
with `{ tenantId, erpName, erpEventCode }` and no outbox row created for that record.

### Implementation for User Story 3

- [x] T022 [US3] Verify `src/services/transformer.ts` — confirm the WARN log for unmapped
  event code includes `{ tenantId: context.tenant.id, erpName: context.connection.erp_name, erpEventCode: extractedErpEventCode }` — add these fields to the log call from T016 if not
  already present

- [x] T023 [P] [US3] Verify `src/db/queries/event-mappings.ts` — confirm `getEventMappings`
  query returns rows with `ORDER BY erp_event_code ASC` for deterministic lookup; add the
  `ORDER BY` clause if missing from T006

**Checkpoint**: User Stories 1, 2, and 3 are all independently functional and testable.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T024 [P] Run `npm run typecheck` (`tsc --noEmit`) — fix any remaining TypeScript errors
  across all modified files: `src/adapters/types.ts`, `src/adapters/tasy/index.ts`,
  `src/config/index.ts`, `src/config/erp-registry.ts`, `src/services/transformer.ts`,
  `src/services/matcher.ts`, `src/services/poller.ts`, `src/services/tenant-orchestrator.ts`,
  `src/index.ts`, `src/lib/mutex.ts`

- [x] T025 [P] Audit CPF masking compliance — review all new and modified log calls in
  `src/services/transformer.ts`, `src/services/poller.ts`, `src/services/tenant-orchestrator.ts`
  for any raw CPF values; ensure all sensitive fields pass through `safeLog()` from
  `src/lib/logger.ts`; add `safeLog()` wrapping where missing

- [x] T026 Run quickstart.md validation end-to-end — apply migration (`npm run db:migrate`),
  seed two tenants per quickstart.md seed script, run `npm run dev`, confirm Validation A
  (two tenant IDs in outbox), B (inactive tenant skipped), C (missing mappings WARN + cycle
  continues)

- [x] T027 [P] Update `ADDING_ERPS.md` — document that new ERP adapters require: (1) a new
  class in `src/adapters/<name>/index.ts` implementing `ErpAdapter` with
  `fetchRecentEvents(): Promise<RawErpRecord[]>`; (2) registration in `createAdapter()` in
  `src/config/erp-registry.ts`; (3) an `erp_connections` row in the database — NOT an env var

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
  - T002 (migration) must run before T003–T009 (query modules that reference new tables)
  - T010 must run before T011 (TasyAdapter depends on RawErpRecord type)
  - T012 can run in parallel with T003–T014 (only imports types)
  - T013 and T014 can run in parallel with T003–T012
- **User Story 1 (Phase 3)**: Depends on all of Phase 2 — no US work until Phase 2 complete
  - T015 before T016 (transformer calls matcher with avimusEventId)
  - T016 before T017 (poller calls transformer with new signature)
  - T017 before T018 (orchestrator calls runSyncCycle)
  - T018 before T019 (index.ts imports orchestrator)
- **User Story 2 (Phase 4)**: Depends on Phase 3 (core logic done in T016)
- **User Story 3 (Phase 5)**: Depends on Phase 3 (core logic done in T016)
- **Polish (Phase 6)**: Depends on Phases 3–5

### Within Phase 2 — Parallel Opportunities

```
T002 (migration)
  ↓ unblocks all below
T003 [P]  T004 [P]  T005 [P]  T006 [P]   ← all parallel
T007 [P]  T008 [P]  T009 [P]             ← all parallel
T010 [P]  T012 [P]  T013 [P]  T014 [P]  ← all parallel
T011      (depends on T010)
```

### Within Phase 3 — Sequential Chain

```
T015 → T016 → T017 → T018 → T019
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup)
2. Complete Phase 2 (Foundational) — critical, blocks everything
3. Complete Phase 3 (User Story 1)
4. **STOP and VALIDATE**: Run quickstart.md Validation A, B, C
5. Deploy/demo if ready

### Incremental Delivery

1. Phase 1 + Phase 2 → Foundation ready
2. Phase 3 → Full cycle working with multi-tenant isolation → **MVP!**
3. Phase 4 → Field mapping edge cases verified → Demo to stakeholders
4. Phase 5 → Event mapping edge cases verified
5. Phase 6 → Hardened and ready for production

---

## Parallel Example: Phase 2

```bash
# After T002 completes, run all of these concurrently:
Task: "Create src/db/queries/tenants.ts"         (T003)
Task: "Create src/db/queries/erp-connections.ts" (T004)
Task: "Create src/db/queries/field-mappings.ts"  (T005)
Task: "Create src/db/queries/event-mappings.ts"  (T006)
Task: "Update src/db/queries/sync-state.ts"      (T007)
Task: "Update src/db/queries/outbox.ts"          (T008)
Task: "Update src/db/queries/audit-log.ts"       (T009)
Task: "Update src/adapters/types.ts"             (T010)
Task: "Create src/services/types.ts"             (T012)
Task: "Update src/config/index.ts"               (T013)
Task: "Update src/config/erp-registry.ts"        (T014)
# Then:
Task: "Update src/adapters/tasy/index.ts"        (T011 — after T010)
```

---

## Notes

- `[P]` tasks = operate on different files with no shared dependencies — run concurrently
- `[Story]` label maps each task to its user story for independent traceability
- Tests not generated (not requested in spec) — use quickstart.md manual validations instead
- T016 is the single most critical task: it implements both field_mappings extraction (US2)
  and event_mappings resolution (US3) — treat with extra care
- Do not start Phase 3 until `npm run typecheck` passes across all Phase 2 changes
