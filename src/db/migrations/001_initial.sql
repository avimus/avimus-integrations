-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Outbox status enum
DO $$ BEGIN
  CREATE TYPE outbox_status AS ENUM ('pendente', 'enviado', 'falhou');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Sync state table
CREATE TABLE IF NOT EXISTS sync_state (
    erp_name        TEXT PRIMARY KEY,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox table
CREATE TABLE IF NOT EXISTS outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  TEXT NOT NULL DEFAULT 'patient_journey',
    aggregate_id    TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (created_at)
    WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_outbox_failed ON outbox (updated_at)
    WHERE status = 'falhou';

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_log (correlation_id)
    WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log (timestamp DESC);
