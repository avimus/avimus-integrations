-- ============================================================
-- Migration 005: Migrate sync_state to endpoint_id key
-- ============================================================
-- All existing sync_state rows are erp_name-based and no longer valid.
-- TRUNCATE and rebuild with endpoint_id as the identifier.

TRUNCATE sync_state;

-- Drop indexes that depend on erp_name before dropping the column
DROP INDEX IF EXISTS idx_sync_state_tenant_erp;
DROP INDEX IF EXISTS idx_sync_state_legacy_erp;

-- Drop erp_name column (all rows gone; no data loss)
ALTER TABLE sync_state DROP COLUMN IF EXISTS erp_name;

-- Add endpoint_id as the new primary correlation key
ALTER TABLE sync_state
  ADD COLUMN IF NOT EXISTS endpoint_id UUID REFERENCES erp_endpoints(id) ON DELETE CASCADE;

ALTER TABLE sync_state
  ALTER COLUMN endpoint_id SET NOT NULL;

-- One sync_state row per endpoint
ALTER TABLE sync_state
  ADD CONSTRAINT sync_state_endpoint_uq UNIQUE (endpoint_id);

-- tenant_id remains as denormalized column for fast monitoring queries
CREATE INDEX IF NOT EXISTS idx_sync_state_tenant
  ON sync_state (tenant_id)
  WHERE tenant_id IS NOT NULL;
