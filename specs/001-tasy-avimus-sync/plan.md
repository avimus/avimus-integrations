# Implementation Plan: Tasy-Ávimus Sync

**Branch**: `001-tasy-avimus-sync` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-tasy-avimus-sync/spec.md`

## Summary

A pure background service that polls the Tasy ERP every 10 minutes for new patient appointment records, transforms them into Ávimus Patient Journey step-completion payloads, and delivers them via HTTP — advancing steps in each patient's active journey. Built with Node.js + TypeScript, PostgreSQL for persistence, node-cron for scheduling, pg for database access, and axios for HTTP calls. No Redis, no web framework.

## Technical Context

**Language/Version**: TypeScript (strict mode) on Node.js 20+ LTS

**Primary Dependencies**: node-cron (scheduler), node-postgres/pg (database), axios (HTTP client)

**Storage**: PostgreSQL — sync_state table (last_synced_at per ERP), outbox table (pending/sent/failed deliveries)

**Testing**: Vitest or Jest (unit + integration tests)

**Target Platform**: Linux server (Docker container)

**Project Type**: Background service (no HTTP endpoints)

**Performance Goals**: Process up to 50 records per 10-minute cycle; complete cycle within 15 minutes of record creation in Tasy

**Constraints**: No Redis; no web frameworks; LGPD compliance (encrypted CPF at rest, masked in logs); mutex lock for overlapping cycle prevention

**Scale/Scope**: 11-50 new appointment records per 10-minute cycle; single-instance deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. HTTP-Only Decoupling | ✅ PASS | All external communication via axios HTTP calls. No ERP SDKs. |
| II. ERP-Plugin Architecture | ✅ PASS | Adapter pattern under `src/adapters/` — Tasy adapter is first implementation. |
| III. Simplicity Over Engineering | ✅ PASS | Minimal dependencies (pg, axios, node-cron). Straightforward outbox pattern. |
| IV. Observability | ✅ PASS | Structured logging with correlation IDs, timestamps, masked CPFs. |
| V. Data Resilience | ✅ PASS | Outbox table with retry + dead-letter. Exponential backoff. Idempotent delivery. |

**Constitution Compliance**: All 5 principles satisfied. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/001-tasy-avimus-sync/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── config/
│   ├── index.ts              # Environment variable loading & validation
│   └── erp-registry.ts       # ERP adapter registry
├── db/
│   ├── index.ts              # pg Pool initialization
│   ├── migrations/
│   │   └── 001_initial.sql   # sync_state + outbox tables
│   └── queries/
│       ├── sync-state.ts     # last_synced_at read/write
│       └── outbox.ts         # Outbox CRUD operations
├── adapters/
│   ├── types.ts              # ErpAdapter interface
│   └── tasy/
│       ├── index.ts          # TasyAdapter implementation
│       └── types.ts          # Tasy-specific types
├── services/
│   ├── poller.ts             # Orchestrates fetch → transform → enqueue
│   ├── transformer.ts        # Maps Tasy records → Ávimus payloads
│   ├── outbox-worker.ts      # Picks pending records, delivers via HTTP
│   └── matcher.ts            # CPF lookup, journey/step matching
├── clients/
│   └── avimus.ts             # Axios wrapper for Ávimus API calls
├── lib/
│   ├── logger.ts             # Structured logger with CPF masking
│   ├── mutex.ts              # Mutex lock for cycle prevention
│   └── backoff.ts            # Exponential backoff utility
└── index.ts                  # Entry point — registers adapters, starts cron

tests/
├── unit/
│   ├── transformer.test.ts
│   ├── matcher.test.ts
│   ├── outbox-worker.test.ts
│   └── lib/
│       ├── logger.test.ts
│       └── backoff.test.ts
├── integration/
│   ├── poller.test.ts
│   └── db/
│       ├── sync-state.test.ts
│       └── outbox.test.ts
└── contract/
    ├── tasy-adapter.test.ts
    └── avimus-client.test.ts
```

**Structure Decision**: Single project with modular internal structure. Adapters separated into `src/adapters/` for ERP-plugin architecture compliance. Services handle orchestration. DB layer isolated under `src/db/`.

## Complexity Tracking

No constitution violations — no complexity tracking required.
