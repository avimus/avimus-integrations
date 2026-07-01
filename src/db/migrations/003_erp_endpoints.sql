-- ============================================================
-- Migration 003: ERP Endpoints
-- ============================================================
-- Each erp_connection can have N configurable endpoints.
-- field_mappings and event_mappings will be keyed by endpoint_id.

CREATE TABLE IF NOT EXISTS erp_endpoints (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID        NOT NULL REFERENCES erp_connections(id) ON DELETE CASCADE,
  path          TEXT        NOT NULL,
  credentials   TEXT,                         -- AES-256 encrypted JSON; null = use connection credentials
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT erp_endpoints_connection_path_key UNIQUE (connection_id, path)
);

CREATE INDEX IF NOT EXISTS idx_erp_endpoints_connection
  ON erp_endpoints (connection_id)
  WHERE is_active = true;
