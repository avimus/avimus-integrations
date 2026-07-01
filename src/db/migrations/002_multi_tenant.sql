-- ============================================================
-- Migration 002: Multi-tenant support
-- ============================================================

-- tenants -------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    slug        TEXT        NOT NULL,
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_key UNIQUE (slug)
);

-- erp_connections -----------------------------------------------
CREATE TABLE IF NOT EXISTS erp_connections (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id),
    erp_name    TEXT        NOT NULL,
    base_url    TEXT        NOT NULL,
    timeout_ms  INTEGER     NOT NULL DEFAULT 10000,
    credentials TEXT,                            -- AES-256 encrypted JSON; null = no auth
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_connections_active
    ON erp_connections (tenant_id)
    WHERE is_active = true;

-- field_mappings ------------------------------------------------
CREATE TABLE IF NOT EXISTS field_mappings (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenants(id),
    erp_name      TEXT        NOT NULL,
    source_field  TEXT        NOT NULL,
    target_field  TEXT        NOT NULL,
    transform     TEXT,                          -- reserved; NOT evaluated in this version
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT field_mappings_tenant_erp_source_key
        UNIQUE (tenant_id, erp_name, source_field)
);

CREATE INDEX IF NOT EXISTS idx_field_mappings_lookup
    ON field_mappings (tenant_id, erp_name);

-- event_mappings ------------------------------------------------
CREATE TABLE IF NOT EXISTS event_mappings (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenants(id),
    erp_name         TEXT        NOT NULL,
    erp_event_code   TEXT        NOT NULL,
    avimus_event_id  TEXT        NOT NULL,
    description      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_mappings_tenant_erp_code_key
        UNIQUE (tenant_id, erp_name, erp_event_code)
);

CREATE INDEX IF NOT EXISTS idx_event_mappings_lookup
    ON event_mappings (tenant_id, erp_name);

-- ============================================================
-- Alter sync_state: migrate PK from erp_name → UUID id
-- ============================================================

-- 1. Add id column (idempotent)
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- 2. Backfill id for any existing rows that somehow have NULL
UPDATE sync_state SET id = gen_random_uuid() WHERE id IS NULL;

-- 3. Drop old erp_name PK and promote id, idempotent via DO block
DO $$ BEGIN
    IF EXISTS (
        SELECT 1
        FROM   information_schema.table_constraints tc
        JOIN   information_schema.key_column_usage  kcu
               ON  tc.constraint_name = kcu.constraint_name
               AND tc.table_schema    = kcu.table_schema
        WHERE  tc.table_name       = 'sync_state'
        AND    tc.constraint_type  = 'PRIMARY KEY'
        AND    kcu.column_name     = 'erp_name'
    ) THEN
        ALTER TABLE sync_state DROP CONSTRAINT sync_state_pkey;
        ALTER TABLE sync_state ALTER COLUMN id SET NOT NULL;
        ALTER TABLE sync_state ADD PRIMARY KEY (id);
    END IF;
END $$;

-- 4. Add tenant_id (idempotent)
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

-- 5. Indexes for tenant-scoped and legacy lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_state_tenant_erp
    ON sync_state (tenant_id, erp_name)
    WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_state_legacy_erp
    ON sync_state (erp_name)
    WHERE tenant_id IS NULL;

-- ============================================================
-- Alter outbox: add tenant_id
-- ============================================================
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_outbox_tenant
    ON outbox (tenant_id)
    WHERE tenant_id IS NOT NULL;

-- ============================================================
-- Alter audit_log: add tenant_id
-- ============================================================
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant
    ON audit_log (tenant_id)
    WHERE tenant_id IS NOT NULL;
