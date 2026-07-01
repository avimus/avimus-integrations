# Implementation Plan: Worker Multi-tenant

**Branch**: `002-worker-multi-tenant` | **Date**: 2026-06-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-worker-multi-tenant/spec.md`

## Summary

Transform the existing single-tenant, env-var-hardcoded worker into a multi-tenant platform
by: (1) adding four new database tables (`tenants`, `erp_connections`, `field_mappings`,
`event_mappings`) and `tenant_id` columns on existing tables; (2) replacing the adapter's
hardcoded field normalization with a database-driven transformer that reads `field_mappings`
at runtime; (3) replacing the per-adapter cron loop with a single cron that iterates all
active `(tenant, erp_connection)` pairs sequentially; and (4) using `event_mappings` to
resolve ERP event codes to Ávimus `integrationEventId` values without hardcoded mappings.

## Technical Context

**Language/Version**: Node.js 20+ / TypeScript strict (unchanged)

**Primary Dependencies**: `pg`, `node-cron`, `axios`, `pino`, `zod` (no new dependencies)

**Storage**: PostgreSQL — raw SQL migrations via `src/db/migrate.ts` (existing runner)

**Testing**: `vitest` + `msw` (already in devDependencies)

**Target Platform**: Linux server — background worker process (no HTTP port in this feature)

**Project Type**: Background worker service (single process, no web framework)

**Performance Goals**: Sequential processing of N active `(tenant, erp_connection)` pairs
within a single cron cycle; each pair's fetch + transform + enqueue must complete before
the next begins. No throughput target defined for this feature (tenants in single digits at
launch).

**Constraints**:
- No new npm dependencies
- No Redis, no external queues
- No parallel tenant processing (sequential confirmed in clarification)
- `transform` column stored but NOT evaluated — all field mapping is direct 1:1 copy
- Worker must still pass `tsc --noEmit` with zero errors
- Existing mutex, retry, and CPF masking logic preserved unchanged

**Scale/Scope**: Single-digit active tenants at launch; up to ~50 field_mappings per
tenant+ERP pair; up to ~20 event_mappings per tenant+ERP pair.

## Constitution Check

*GATE: Must pass before implementation begins. Re-check after all tasks complete.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. HTTP-Only Decoupling | ✅ PASS | Adapter changes preserve HTTP-only ERP communication |
| II. ERP-Plugin Architecture | ✅ PASS | Adapter interface preserved; `createAdapter(connection)` replaces env-driven factory |
| III. Simplicity Over Engineering | ✅ PASS | No new deps; sequential loop; pure SQL migrations |
| IV. Observability | ✅ PASS | All new log calls carry `tenantId`; CPF masking unchanged |
| V. Data Resilience | ✅ PASS | Outbox + retry + dead-letter unchanged; `tenant_id` added |
| VI. Multi-tenant Isolation | ✅ PASS | All queries scoped by `tenant_id`; enforcement at application layer |
| VII. Configuration over Code | ✅ PASS | `field_mappings` + `event_mappings` replace all hardcoded field names |
| VIII. Admin as Consumer | ✅ PASS | No admin interface in this feature; no change to boundary |

**No violations. Gate passes.**

## Project Structure

### Documentation (this feature)

```text
specs/002-worker-multi-tenant/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — not yet created)
```

### Source Code Changes

```text
src/
├── adapters/
│   ├── types.ts                    MODIFY — RawEvent → RawErpRecord
│   └── tasy/
│       └── index.ts                MODIFY — mapToRawEvent → mapToRawErpRecord (return rawPayload)
├── config/
│   ├── index.ts                    MODIFY — remove TASY_BASE_URL, TASY_TIMEOUT_MS, ERP_NAMES
│   └── erp-registry.ts             MODIFY — createAdapter(erpName, connection) from DB row
├── db/
│   ├── migrations/
│   │   └── 002_multi_tenant.sql    NEW — 4 new tables + ALTER TABLE on 3 existing
│   └── queries/
│       ├── tenants.ts              NEW — getActiveTenants()
│       ├── erp-connections.ts      NEW — getActiveConnections(tenantId)
│       ├── field-mappings.ts       NEW — getFieldMappings(tenantId, erpName)
│       ├── event-mappings.ts       NEW — getEventMappings(tenantId, erpName)
│       ├── sync-state.ts           MODIFY — add tenantId param; SELECT/INSERT/UPDATE pattern
│       ├── outbox.ts               MODIFY — add tenantId to EnqueueInput + INSERT + claimPending filter
│       └── audit-log.ts            MODIFY — add optional tenantId to AuditEntry + INSERT
├── services/
│   ├── types.ts                    NEW — TenantErpContext interface
│   ├── tenant-orchestrator.ts      NEW — runMultiTenantSyncCycle()
│   ├── transformer.ts              MODIFY — accept RawErpRecord + TenantErpContext; use fieldMappings
│   ├── matcher.ts                  MODIFY — findMatchingStep accepts avimusEventId (rename param)
│   └── poller.ts                   MODIFY — accept TenantErpContext; pass tenantId to all DB calls
└── index.ts                        MODIFY — single cron with JOB_LOCKS.SYNC_CYCLE; call orchestrator

.env.example                        MODIFY — remove TASY_* vars; add seeding note
```

**Structure Decision**: Single project (existing layout). All changes within `src/`. No new
top-level directories. Tests go in `tests/unit/` and `tests/integration/` (existing structure).

---

## Key Design Decisions

### D1 — RawErpRecord replaces RawEvent

`ErpAdapter.fetchRecentEvents()` returns `RawErpRecord[]` instead of `RawEvent[]`.
`RawErpRecord = { eventId: string, rawPayload: Record<string, unknown> }`.
The adapter no longer normalizes field names — it returns the ERP data verbatim.
This is what makes field_mappings meaningful: the transformer reads `rawPayload` using the
configured `source_field` names and writes to canonical `target_field` names.

### D2 — Transformer extracts canonical fields via field_mappings

The transformer iterates `context.fieldMappings` to build a canonical set:
- Finds mapping where `target_field === 'cpf'` → `rawPayload[source_field]` as string
- Finds mapping where `target_field === 'eventDate'` → `rawPayload[source_field]` as Date
- Finds mapping where `target_field === 'erpEventCode'` → `rawPayload[source_field]` as string
- All other mappings → appended to outbox payload metadata

Missing mandatory target fields (cpf, eventDate, erpEventCode) cause the record to be skipped
with a WARN log. The `transform` column is persisted but never evaluated.

### D3 — Event resolution in transformer, not matcher

After extracting `erpEventCode`, the transformer looks up `context.eventMappings` to find the
`avimus_event_id`. If not found → record skipped with WARN. The matcher receives the resolved
`avimusEventId` — it never sees raw ERP event codes.

### D4 — Sequential (tenant, erp_connection) iteration

`runMultiTenantSyncCycle()` loops: `for tenant of activeTenants → for connection of activeConnections`.
One PostgreSQL advisory lock (`JOB_LOCKS.SYNC_CYCLE = 100_001`) covers the entire loop.
The per-adapter lock approach (`erpLockId`) is retired.

### D5 — sync_state PK migration

Drop `erp_name` as PK. Add `id UUID` as new PK. Add `tenant_id UUID` nullable.
Two partial unique indexes:
- `ON sync_state(tenant_id, erp_name) WHERE tenant_id IS NOT NULL` — for new tenant rows
- `ON sync_state(erp_name) WHERE tenant_id IS NULL` — for legacy single-tenant row

UPSERT uses SELECT-then-INSERT/UPDATE (partial index cannot be named in ON CONFLICT).

### D6 — credentials stored as encrypted TEXT

`erp_connections.credentials` is `TEXT` (not `JSONB`). The application encrypts the
JSON-serialized credential object before storage using `src/lib/crypto.ts`. Decrypted on read
into a typed credentials object. NULL credentials = no authentication required.

### D7 — Config env var cleanup

Remove from Zod schema: `tasyBaseUrl`, `tasyTimeoutMs`, `erpNames`.
These are now read from the `erp_connections` table at runtime.
The config schema shrinks; the `.env.example` is updated accordingly.

---

## Phase 0 — Completed

All unknowns resolved. See `research.md` for full rationale on each decision.

## Phase 1 — Completed

Data model, contracts (N/A — no external HTTP interface in this feature), and quickstart
documented. See `data-model.md` and `quickstart.md`.

---

## Constitution Check (post-design re-evaluation)

All 8 principles verified against the design above. No violations introduced.
Principle VII compliance confirmed: no ERP field names or event codes appear as string
literals in business logic — all resolved at runtime from DB tables.
