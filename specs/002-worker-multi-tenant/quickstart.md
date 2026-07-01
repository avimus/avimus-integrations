# Quickstart: Worker Multi-tenant

**Branch**: `002-worker-multi-tenant` | **Date**: 2026-06-30

This guide covers how to run the worker after the multi-tenant migration is applied.

---

## Prerequisites

- PostgreSQL running with the `avimus_prod` database accessible
- `.env` configured (see updated `.env.example` — the Tasy-specific vars are removed)
- Node.js 20+

---

## 1. Apply Migrations

```bash
npm run db:migrate
```

This runs both:
- `src/db/migrations/001_initial.sql` — original schema (idempotent)
- `src/db/migrations/002_multi_tenant.sql` — new tables + column additions

---

## 2. Seed Initial Data (required before first run)

After migration, seed at least one tenant and ERP connection directly in the database.
There is no admin UI or API for this in Feature 002 — use `psql` or a seed script.

### Example seed (Tasy, Hospital São Lucas)

```sql
-- 1. Insert tenant
INSERT INTO tenants (name, slug)
VALUES ('Hospital São Lucas', 'hospital-sao-lucas')
RETURNING id;
-- Note the returned UUID as <tenant_id>

-- 2. Insert ERP connection
-- credentials is the AES-256 encrypted form of '{}' (or your actual auth JSON)
-- Use the application's encrypt() function to generate this value
INSERT INTO erp_connections (tenant_id, erp_name, base_url, timeout_ms, credentials)
VALUES (
  '<tenant_id>',
  'tasy',
  'http://192.168.80.190:9001',
  10000,
  '<encrypted_credentials>'
);
-- Note the returned id

-- 3. Insert field mappings (example for a hospital where CPF field is named 'cpf')
INSERT INTO field_mappings (tenant_id, erp_name, source_field, target_field)
VALUES
  ('<tenant_id>', 'tasy', 'cpf',               'cpf'),
  ('<tenant_id>', 'tasy', 'evento_codigo',      'erpEventCode'),
  ('<tenant_id>', 'tasy', 'data_atendimento',   'eventDate'),
  ('<tenant_id>', 'tasy', 'protocolo',          'protocolId');

-- 4. Insert event mappings
INSERT INTO event_mappings (tenant_id, erp_name, erp_event_code, avimus_event_id)
VALUES
  ('<tenant_id>', 'tasy', 'CONSULTA_REALIZADA', 'consulta_realizada'),
  ('<tenant_id>', 'tasy', 'EXAME_COLETADO',     'exame_laboratorial'),
  ('<tenant_id>', 'tasy', 'ALTA_HOSPITALAR',    'alta_concedida');
```

### Encrypting credentials

Run this one-liner to generate the encrypted credential string for seeding:

```bash
node -e "
  import('./src/lib/crypto.js').then(({ encrypt }) => {
    const key = process.env.ENCRYPTION_KEY;
    const creds = JSON.stringify({ apiToken: 'YOUR_TOKEN_HERE' });
    console.log(encrypt(creds, key));
  });
"
```

---

## 3. Updated .env

The following env vars are **removed** in Feature 002 (move to DB):

```
# REMOVED — now in erp_connections table:
# TASY_BASE_URL=
# TASY_TIMEOUT_MS=
# ERP_NAMES=
```

The remaining required vars:

```env
DATABASE_URL=postgres://user:pass@localhost:5432/avimus_prod
AVIMUS_API_URL=https://api.avimus.com
AVIMUS_API_TOKEN=your-token
ENCRYPTION_KEY=your-32-char-key
NODE_ENV=development
LOG_LEVEL=info
POLLING_INTERVAL_MINUTES=10
MAX_RETRIES=3
INITIAL_LOOKBACK_HOURS=24
```

---

## 4. Run the Worker

```bash
# Development (tsx, hot reload)
npm run dev

# Production (compiled)
npm run build && npm start
```

Expected startup log:

```
{"level":"info","msg":"Starting Ávimus Integrations worker"}
{"level":"info","active_tenants":2,"msg":"Multi-tenant sync cycle scheduled"}
{"level":"info","msg":"Outbox delivery scheduled"}
{"level":"info","msg":"Service started successfully"}
```

---

## 5. Validate the Feature

### Validation A — Two tenants processed in same cycle

1. Seed two active tenants with one ERP connection each (different Tasy base URLs or same,
   both fine).
2. Trigger the cron manually (or set `POLLING_INTERVAL_MINUTES=1`).
3. Check `outbox` table: both tenant rows should appear with non-null `tenant_id`.

```sql
SELECT tenant_id, erp_name, count(*) FROM outbox GROUP BY 1, 2;
```

### Validation B — Inactive tenant skipped

1. Set one tenant to `is_active = false`.
2. Trigger a cycle.
3. Confirm no new outbox rows for that tenant's `tenant_id`.

```sql
UPDATE tenants SET is_active = false WHERE slug = 'hospital-sao-lucas';
-- Trigger cycle, then:
SELECT count(*) FROM outbox WHERE tenant_id = '<tenant_id>' AND created_at > now() - interval '2 min';
-- Should return 0
```

### Validation C — Missing field_mappings → WARN log, no crash

1. Delete all field_mappings for one tenant+ERP.
2. Trigger a cycle.
3. Confirm a WARN log like `"No field_mappings configured for tenant X / ERP Y"`.
4. Confirm the OTHER tenant was still processed (outbox rows for the other tenant appeared).

---

## 6. Type Check

```bash
npm run typecheck
```

All modules must pass `tsc --noEmit` with zero errors.

---

## 7. Run Tests

```bash
npm test
```

Tests include:
- `tests/unit/transformer.test.ts` — field extraction via fieldMappings, event code resolution
- `tests/unit/matcher.test.ts` — unchanged behavior
- `tests/integration/multi-tenant-cycle.test.ts` — end-to-end with two tenants
