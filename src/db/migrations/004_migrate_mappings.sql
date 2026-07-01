-- ============================================================
-- Migration 004: Migrate field_mappings and event_mappings
-- ============================================================
-- RESET LIMPO: all existing mappings are deleted.
-- field_mappings and event_mappings are re-keyed by endpoint_id.
-- Tenants must reconfigure endpoints + mappings via admin after deploy.

-- Reset limpo
TRUNCATE field_mappings;
TRUNCATE event_mappings;

-- ============================================================
-- field_mappings: replace (tenant_id, erp_name) with endpoint_id
-- ============================================================
ALTER TABLE field_mappings
  DROP CONSTRAINT IF EXISTS field_mappings_tenant_erp_source_key,
  DROP CONSTRAINT IF EXISTS field_mappings_tenant_id_erp_name_source_field_key;

ALTER TABLE field_mappings
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS erp_name;

ALTER TABLE field_mappings
  ADD COLUMN IF NOT EXISTS endpoint_id UUID REFERENCES erp_endpoints(id) ON DELETE CASCADE;

ALTER TABLE field_mappings
  ALTER COLUMN endpoint_id SET NOT NULL;

ALTER TABLE field_mappings
  ADD CONSTRAINT field_mappings_endpoint_source_uq UNIQUE (endpoint_id, source_field);

DROP INDEX IF EXISTS idx_field_mappings_lookup;

CREATE INDEX IF NOT EXISTS idx_field_mappings_endpoint
  ON field_mappings (endpoint_id);

-- ============================================================
-- event_mappings: replace (tenant_id, erp_name) with endpoint_id
--                 add avimus_action, make avimus_event_id nullable
-- ============================================================
ALTER TABLE event_mappings
  DROP CONSTRAINT IF EXISTS event_mappings_tenant_erp_code_key,
  DROP CONSTRAINT IF EXISTS event_mappings_tenant_id_erp_name_erp_event_code_key;

ALTER TABLE event_mappings
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS erp_name;

ALTER TABLE event_mappings
  ADD COLUMN IF NOT EXISTS endpoint_id UUID REFERENCES erp_endpoints(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS avimus_action TEXT NOT NULL DEFAULT 'complete_step'
    CHECK (avimus_action IN ('complete_step', 'start_journey'));

ALTER TABLE event_mappings
  ALTER COLUMN endpoint_id SET NOT NULL;

-- avimus_event_id is only required for complete_step; NULL is valid for start_journey
ALTER TABLE event_mappings
  ALTER COLUMN avimus_event_id DROP NOT NULL;

ALTER TABLE event_mappings
  ADD CONSTRAINT event_mappings_endpoint_code_uq UNIQUE (endpoint_id, erp_event_code);

DROP INDEX IF EXISTS idx_event_mappings_lookup;

CREATE INDEX IF NOT EXISTS idx_event_mappings_endpoint
  ON event_mappings (endpoint_id);
