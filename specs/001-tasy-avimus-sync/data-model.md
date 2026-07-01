# Data Model: Tasy-Ávimus Sync

**Date**: 2026-06-29

## Entities

### 1. sync_state

Tracks the last successful sync timestamp per ERP adapter.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `erp_name` | `TEXT` | `PRIMARY KEY` | ERP adapter identifier (e.g., `tasy`) |
| `last_synced_at` | `TIMESTAMPTZ` | `NULLABLE` | Timestamp of last successful sync. NULL on first run. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Record creation time |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Last modification time |

**State transitions**: None — this is a simple key-value tracker.

**Business rules**:
- Updated only AFTER all records from a cycle are successfully enqueued (FR-002)
- NULL value triggers 24-hour lookback (FR-012)
- Updated atomically within the same transaction as outbox inserts

---

### 2. outbox

Persists delivery payloads for Ávimus API. Implements the outbox pattern for data resilience.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique identifier |
| `aggregate_type` | `TEXT` | `NOT NULL` | Always `'patient_journey'` for this feature |
| `aggregate_id` | `TEXT` | `NOT NULL` | Patient CPF (encrypted via pgcrypto) |
| `event_type` | `TEXT` | `NOT NULL` | Always `'step_completed'` for this feature |
| `payload` | `JSONB` | `NOT NULL` | Ávimus step-completion payload |
| `status` | `outbox_status` | `NOT NULL DEFAULT 'pendente'` | Delivery status enum |
| `attempt_count` | `INTEGER` | `NOT NULL DEFAULT 0` | Number of delivery attempts |
| `max_attempts` | `INTEGER` | `NOT NULL DEFAULT 3` | Maximum retry count (FR-006) |
| `last_error` | `TEXT` | `NULLABLE` | Last failure error message |
| `correlation_id` | `UUID` | `NOT NULL` | For log correlation across components |
| `erp_name` | `TEXT` | `NOT NULL` | Source ERP adapter name |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | When the record was enqueued |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Last status change |

**Enum type**:
```sql
CREATE TYPE outbox_status AS ENUM ('pendente', 'enviado', 'falhou');
```

**Indexes**:
```sql
-- Fast polling of pending records
CREATE INDEX idx_outbox_pending ON outbox (created_at)
    WHERE status = 'pendente';

-- Fast lookup of failed records for manual review
CREATE INDEX idx_outbox_failed ON outbox (updated_at)
    WHERE status = 'falhou';
```

**State transitions**:
```
pendente ──(delivery success)──▶ enviado
pendente ──(delivery failure, attempts < max)──▶ pendente (attempt_count++)
pendente ──(delivery failure, attempts >= max)──▶ falhou
```

**Business rules**:
- `FOR UPDATE SKIP LOCKED` for safe worker claiming (FR-013)
- `aggregate_id` stores encrypted CPF (FR-014)
- `correlation_id` propagated to all log entries (FR-007)
- `last_error` captures failure reason for manual review (FR-006)
- Old `enviado` records cleaned up after 7 days

---

### 3. audit_log

Immutable audit trail for all data access and modifications (FR-016).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `timestamp` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | When the action occurred |
| `action` | `TEXT` | `NOT NULL` | Action performed (e.g., `sync_cycle.start`, `outbox.enqueue`, `delivery.attempt`) |
| `component` | `TEXT` | `NOT NULL` | Source component (e.g., `poller`, `outbox-worker`, `matcher`) |
| `record_type` | `TEXT` | `NULLABLE` | Entity type affected (e.g., `outbox`, `sync_state`) |
| `record_id` | `TEXT` | `NULLABLE` | Entity ID affected |
| `erp_name` | `TEXT` | `NULLABLE` | ERP adapter name (if applicable) |
| `details` | `JSONB` | `NULLABLE` | Additional context (CPF masked, record counts, etc.) |
| `correlation_id` | `UUID` | `NULLABLE` | Links to outbox record or sync cycle |

**Indexes**:
```sql
CREATE INDEX idx_audit_correlation ON audit_log (correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE INDEX idx_audit_timestamp ON audit_log (timestamp DESC);
```

**Business rules**:
- Append-only — no UPDATE or DELETE operations permitted
- CPF values masked in `details` JSONB before insertion
- Retention: configurable, default 90 days

---

## Relationships

```
sync_state (1) ──── (N) outbox
    │                     │
    │ erp_name            │ erp_name
    │                     │
    └─────────────────────┘
            linked by erp_name

outbox (1) ──── (N) audit_log
    │                     │
    │ correlation_id      │ correlation_id
    │                     │
    └─────────────────────┘
            linked by correlation_id
```

## Schema DDL

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Outbox status enum
CREATE TYPE outbox_status AS ENUM ('pendente', 'enviado', 'falhou');

-- Sync state table
CREATE TABLE sync_state (
    erp_name        TEXT PRIMARY KEY,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox table
CREATE TABLE outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  TEXT NOT NULL DEFAULT 'patient_journey',
    aggregate_id    TEXT NOT NULL,  -- encrypted CPF
    event_type      TEXT NOT NULL DEFAULT 'step_completed',
    payload         JSONB NOT NULL,
    status          outbox_status NOT NULL DEFAULT 'pendente',
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    last_error      TEXT,
    correlation_id  UUID NOT NULL,
    erp_name        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox (created_at)
    WHERE status = 'pendente';
CREATE INDEX idx_outbox_failed ON outbox (updated_at)
    WHERE status = 'falhou';

-- Audit log table
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    action          TEXT NOT NULL,
    component       TEXT NOT NULL,
    record_type     TEXT,
    record_id       TEXT,
    erp_name        TEXT,
    details         JSONB,
    correlation_id  UUID
);

CREATE INDEX idx_audit_correlation ON audit_log (correlation_id)
    WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp DESC);
```
