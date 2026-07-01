# Tasks: Tasy-Ávimus Sync

**Input**: Design documents from `/specs/001-tasy-avimus-sync/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependencies, and basic configuration

- [x] T001 Initialize Node.js + TypeScript project: `package.json` with `type: "module"`, `tsconfig.json` with strict mode, `.gitignore` at repo root
- [x] T002 [P] Install runtime dependencies: `pg`, `node-cron`, `axios`, `zod`, `pino`, `dotenv`
- [x] T003 [P] Install dev dependencies: `vitest`, `msw`, `@types/pg`, `@types/node-cron`, `typescript`, `tsx`
- [x] T004 [P] Add npm scripts in `package.json`: `dev`, `start`, `build`, `test`, `typecheck`, `lint`, `db:migrate`
- [x] T005 [P] Create `.env.example` with all environment variables per quickstart.md
- [x] T006 Create `src/config/index.ts` — Zod schema validating all env vars, export typed `Config` object, crash on invalid config

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Create `src/db/index.ts` — pg Pool factory: `max: 10`, `keepAlive: true`, `statement_timeout: 30s`, error handler, exported pool instance
- [x] T008 Create `src/db/migrations/001_initial.sql` — DDL from data-model.md: `pgcrypto` extension, `outbox_status` enum, `sync_state`, `outbox`, `audit_log` tables with all indexes
- [x] T009 [P] Create `src/lib/logger.ts` — Pino logger with CPF field-name redaction via `redact` config + `safeLog()` wrapper with regex masking (`***.XXX.XXX-**`)
- [x] T010 [P] Create `src/lib/mutex.ts` — `withAdvisoryLock()` using dedicated pg connection, `pg_try_advisory_lock()`, auto-release on completion, `JOB_LOCKS` constants
- [x] T011 [P] Create `src/lib/backoff.ts` — `withRetry()` utility: full jitter, `base=500ms`, `cap=10s`, `maxAttempts=3`, `Retry-After` header support, `AbortSignal` support
- [x] T012 [P] Create `src/adapters/types.ts` — `RawEvent` interface, `ErpAdapter` interface with `fetchRecentEvents(since: Date)`, `ErpAdapterError` class with `transient` flag
- [x] T013 [P] Create `src/config/erp-registry.ts` — `ADAPTER_FACTORIES` static map, `resolveActiveAdapters(env)` function, `ERP_NAMES` env var parsing
- [x] T014 [P] Create `src/clients/avimus.ts` — Axios wrapper for Ávimus API: `searchPatient(cpf)`, `listJourneys(patientId)`, `listSteps(journeyId)`, `completeStep(stepId, payload)`, Bearer token auth, configurable timeout
- [x] T015 Create `src/db/queries/sync-state.ts` — `getLastSyncedAt(erpName)`, `updateSyncState(erpName, timestamp)` using transaction
- [x] T016 Create `src/db/queries/outbox.ts` — `enqueue(record)`, `claimPending(limit)` with `FOR UPDATE SKIP LOCKED`, `markSent(id)`, `markFailed(id, error)`, `incrementAttempt(id)`
- [x] T017 [P] Create `src/db/queries/audit-log.ts` — `logAudit(action, component, details)` append-only insert, CPF masking applied to `details` before insert

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 — Automated Event Sync Cycle (Priority: P1) 🎯 MVP

**Goal**: Service polls Tasy ERP every 10 minutes, transforms records, enqueues to outbox, and delivers to Ávimus API

**Independent Test**: Trigger a manual sync cycle and verify new Tasy records appear as completed steps in Ávimus patient journeys

### Implementation for User Story 1

- [x] T018 [P] [US1] Create `src/adapters/tasy/types.ts` — Tasy-specific types: `TasyAtendimento`, `TasyApiResponse` matching Tasy API contract from `contracts/tasy-api.md`
- [x] T019 [US1] Create `src/adapters/tasy/index.ts` — `TasyAdapter` implementing `ErpAdapter`: HTTP GET to `/atendimentos/recentes`, map Tasy fields to `RawEvent[]`, throw `ErpAdapterError` with correct `transient` classification per contract
- [x] T020 [P] [US1] Create `src/services/matcher.ts` — `matchPatient(cpf)` calling Ávimus search, `matchJourney(patientId)` filtering `status=ativo`, `matchStep(journeyId, erpEventCode)` matching `integrationEventId`, return null + log "no match found" when any step fails
- [x] T021 [US1] Create `src/services/transformer.ts` — `transformEvent(rawEvent)`: validate CPF not null/empty (FR-011), call matcher, build Ávimus step-completion payload, return null if no match
- [x] T022 [US1] Create `src/services/poller.ts` — `runSyncCycle(adapter, ...)`: read `last_synced_at`, call `adapter.fetchRecentEvents(since)`, transform each event, enqueue to outbox, update sync state only after all records enqueued (FR-002), handle 24h lookback when null (FR-012), structured logging per FR-007
- [x] T023 [US1] Create `src/services/outbox-worker.ts` — `processPendingDeliveries()`: claim pending records with `FOR UPDATE SKIP LOCKED`, call Ávimus `completeStep()`, mark sent on 200, increment attempt on failure, structured logging per FR-007
- [x] T024 [US1] Create `src/index.ts` — Entry point: load config, create pool, register adapters from registry, schedule cron jobs (one per ERP), register `SIGTERM`/`SIGINT` handlers (stop tasks → abort HTTP → pool.end() → hard timeout), start outbox worker on same cron or separate schedule

**Checkpoint**: End-to-end sync cycle works: Tasy → transform → enqueue → deliver to Ávimus

---

## Phase 4: User Story 2 — Failed Delivery Retry with Dead-Letter (Priority: P2)

**Goal**: Failed deliveries retry up to 3 times with exponential backoff, then mark as `falhou` with clear error logs

**Independent Test**: Simulate Ávimus API outage, verify retries then `falhou` status with structured error logs

### Implementation for User Story 2

- [x] T025 [US2] Update `src/services/outbox-worker.ts` — Wrap Ávimus delivery call in `withRetry()` from backoff utility, respect `max_attempts` from outbox record, on exhausted retries: set status `falhou`, log error with correlation ID, CPF (masked), step ID, attempt number per acceptance scenario 4
- [x] T026 [US2] Update `src/db/queries/outbox.ts` — Add `markFailed(id, error, correlationId)` that sets status `falhou`, updates `last_error` and `updated_at`, ensure `incrementAttempt` only runs when `attempt_count < max_attempts`
- [x] T027 [US2] Add structured error logging in `src/services/outbox-worker.ts` — Each failure log includes: timestamp, correlation ID, patient CPF (masked), step ID, attempt number, error message (FR-007, US2 acceptance scenario 4)
- [x] T028 [US2] Verify dead-letter behavior — `falhou` records are NOT retried by outbox worker, only `pendente` records with `attempt_count < max_attempts` are claimed

**Checkpoint**: Failed deliveries retry correctly, then permanently fail with full audit trail

---

## Phase 5: User Story 3 — Patient Journey Matching (Priority: P3)

**Goal**: Transformer correctly matches Tasy records to the right patient and active journey in Ávimus

**Independent Test**: Provide a known CPF and Tasy record, verify correct Ávimus patient, journey, and step are identified

### Implementation for User Story 3

- [x] T029 [US3] Enhance `src/services/matcher.ts` — Implement full matching pipeline: (1) CPF lookup via Ávimus `/api/v1/patients?cpf=`, (2) active journey check via `/api/v1/journeys?patientId=&status=ativo`, (3) step matching by `integrationEventId` === `erpEventCode`, (4) return structured match result with patient/journey/step IDs or null
- [x] T030 [US3] Enhance `src/services/transformer.ts` — Handle all edge cases: null/empty CPF skip + warn (FR-011), no patient found → log + skip, no active journey → log + skip, no matching step → log + skip, all matched → build payload with step ID, result, notes, metadata
- [x] T031 [US3] Add idempotency to `src/services/outbox-worker.ts` — Before completing a step, check if same `aggregate_id` + `event_type` + `step_id` already succeeded recently, prevent duplicate step completions in Ávimus (edge case from spec)

**Checkpoint**: Matching logic is accurate, edge cases handled, no wrong-step advancements

---

## Phase 6: User Story 4 — ERP Adapter Extensibility (Priority: P4)

**Goal**: Adding a new ERP requires only implementing adapter + registering in config, zero core changes

**Independent Test**: Review adapter interface and confirm a hypothetical second adapter could be added without modifying core files

### Implementation for User Story 4

- [x] T032 [US4] Validate adapter isolation — Audit `src/services/` files for any ERP-specific conditionals or logic outside `src/adapters/`, refactor if found, ensure core only references `ErpAdapter` interface and `RawEvent` type
- [x] T033 [US4] Create `ADDING_ERPS.md` at repo root — Document: (1) create `src/adapters/{name}/index.ts` implementing `ErpAdapter`, (2) add factory to `src/config/erp-registry.ts`, (3) add env vars, (4) set `ERP_NAMES` — include example with TOTVS adapter
- [x] T034 [US4] Verify registry auto-inclusion — Confirm that `resolveActiveAdapters()` returns new adapter instances when `ERP_NAMES` includes them, and cron loop schedules them automatically

**Checkpoint**: Adapter pattern fully validated, documented, and ready for future ERPs

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Audit trail, cleanup, and final validation

- [x] T035 [P] Implement `audit_log` writes in `src/db/queries/audit-log.ts` — Integrate into poller (cycle start/end), outbox worker (enqueue/delivery attempt/success/failure), matcher (lookup results), ensure CPF masked in all `details` JSONB
- [x] T036 [P] Add database migration runner — Simple script in `src/db/migrations/` that reads `.sql` files and executes against target DB, idempotent (check if table exists before creating)
- [x] T037 [P] Create `.env` from `.env.example` with placeholder values for local development
- [x] T038 Run `npm run typecheck` and verify zero errors
- [x] T039 Run `npm test` and verify all tests pass
- [x] T040 Run quickstart.md validation — follow all steps, confirm service starts and connects to DB

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 completion — BLOCKS all user stories
- **Phase 3 (US1)**: Depends on Phase 2 completion — core sync pipeline
- **Phase 4 (US2)**: Depends on Phase 3 (needs outbox worker from US1)
- **Phase 5 (US3)**: Depends on Phase 3 (needs matcher/transformer from US1)
- **Phase 6 (US4)**: Depends on Phase 3 (needs adapter implementation from US1)
- **Phase 7 (Polish)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2 — no dependencies on other stories
- **US2 (P2)**: Extends US1 outbox worker with retry logic — should be implemented after US1
- **US3 (P3)**: Enhances US1 matcher/transformer — should be implemented after US1
- **US4 (P4)**: Validates US1 adapter architecture — should be implemented after US1

### Within Each User Story

- Types/interfaces before implementations
- Services before entry point
- Core implementation before edge cases
- Story complete before moving to next priority

### Parallel Opportunities

- **Phase 1**: T002, T003, T004, T005 can all run in parallel
- **Phase 2**: T009, T010, T011, T012, T013, T014, T017 can all run in parallel
- **Phase 3**: T018 and T020 can run in parallel (different modules)
- **Phase 7**: T035, T036, T037 can all run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch adapter types and matcher in parallel:
Task: "Create src/adapters/tasy/types.ts — Tasy-specific types"
Task: "Create src/services/matcher.ts — CPF/journey/step matching"

# Then adapter implementation (depends on types):
Task: "Create src/adapters/tasy/index.ts — TasyAdapter implementation"

# Then transformer (depends on matcher):
Task: "Create src/services/transformer.ts — event transformation"

# Then poller + outbox worker + entry point (depend on transformer):
Task: "Create src/services/poller.ts — sync cycle orchestration"
Task: "Create src/services/outbox-worker.ts — delivery worker"
Task: "Create src/index.ts — entry point with cron setup"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Manual sync cycle works end-to-end
5. Deploy if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 → Manual sync works → Deploy (MVP!)
3. Add US2 → Retry + dead-letter works → Deploy
4. Add US3 → Matching accuracy validated → Deploy
5. Add US4 → Adapter pattern documented → Deploy

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
