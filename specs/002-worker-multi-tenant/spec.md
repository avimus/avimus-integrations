# Feature Specification: Worker Multi-tenant

**Feature Branch**: `002-worker-multi-tenant`

**Created**: 2026-06-30

**Status**: Draft

**Input**: Transformar o worker single-tenant hardcoded do avimus-integrations em multi-tenant,
adicionando isolamento completo por tenant, configuração de ERP por banco de dados e uso de
mapeamentos de campos e eventos persistidos.

## Clarifications

### Session 2026-06-30

- Q: Within a single cron cycle, should tenants be processed sequentially or concurrently? → A: Sequentially — each `(tenant, erp_connection)` pair is processed one after another in a deterministic order.
- Q: A coluna `transform` em `field_mappings` é usada ou ignorada nesta feature? → A: Ignorada — coluna criada no schema para uso futuro, mas o worker sempre faz cópia direta 1:1 nesta feature; nenhuma função de transformação é implementada.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sync Cycle Iterates Active Tenants (Priority: P1)

An operations engineer activates two hospital clients (tenants) in the integrations database.
When the cron job fires, the worker fetches all active tenants and their active ERP connections
from the database, runs a complete sync cycle for each `(tenant, erp_connection)` pair, and
produces isolated outbox entries and audit logs for each tenant — with no cross-tenant data mixing.

**Why this priority**: This is the core behavioral change. Without multi-tenant iteration, no other
story can be validated. It is also the highest-risk change because it replaces the current
environment-variable-based single-tenant loop.

**Independent Test**: Seed two active tenants with one active ERP connection each. Fire the cron
manually. Verify that `outbox` rows for tenant A contain only tenant A's `tenant_id` and rows for
tenant B contain only tenant B's `tenant_id`. Verify `sync_state` and `audit_log` rows are
similarly isolated.

**Acceptance Scenarios**:

1. **Given** two active tenants each with one active ERP connection,
   **When** the cron cycle runs,
   **Then** the worker processes both `(tenant, erp_connection)` pairs independently and commits
   separate outbox/sync_state/audit_log rows carrying the correct `tenant_id`.

2. **Given** one active tenant and one inactive tenant both in the database,
   **When** the cron cycle runs,
   **Then** only the active tenant is processed; no rows are created for the inactive tenant.

3. **Given** an active tenant whose ERP connection has `is_active = false`,
   **When** the cron cycle runs,
   **Then** that ERP connection is skipped; the tenant's other active connections (if any) are
   still processed.

4. **Given** two concurrent cron ticks arrive while the first cycle is still running,
   **When** the mutex guard is evaluated,
   **Then** the second tick is dropped and a WARN log is emitted; no duplicate outbox entries
   are created.

---

### User Story 2 - Field Mappings Loaded from Database (Priority: P2)

A hospital's integration administrator configures the field de-para for their tenant in the
`field_mappings` table (e.g., mapping `codigo_pessoa_fisica` → `cpf`). The worker reads these
mappings at runtime and uses them to transform ERP records into the Ávimus payload format,
without any hardcoded field names in the source code.

**Why this priority**: Field mappings are the core of the "configuration over code" principle.
Without this story, each new hospital client still requires a code change. This is the blocker for
the admin drag-and-drop interface (Feature 004).

**Independent Test**: Seed one tenant+ERP with three `field_mappings` rows. Run a sync cycle.
Inspect the outbox payload: the `target_field` values must appear, sourced from the correct
`source_field` values of the ERP record. Remove one mapping row and re-run: the corresponding
target field must be absent from the payload.

**Acceptance Scenarios**:

1. **Given** a tenant+ERP has `field_mappings` rows configured,
   **When** the transformer processes an ERP record,
   **Then** each `source_field` value from the ERP record is copied directly to the corresponding
   `target_field` in the outbox payload (1:1, no transformation applied).

2. **Given** a tenant+ERP has no `field_mappings` rows in the database,
   **When** the cron cycle reaches that tenant+ERP,
   **Then** the worker logs a WARN ("no field_mappings configured for tenant X / ERP Y"), skips
   the sync for that pair, and continues to the next `(tenant, erp_connection)` without
   aborting the full cycle.

---

### User Story 3 - Event Mappings Loaded from Database (Priority: P3)

A hospital's integration administrator configures the event de-para for their tenant in the
`event_mappings` table (e.g., mapping `CONSULTA_REALIZADA` → `consulta_realizada`). The worker
reads these mappings to find the correct Ávimus `integrationEventId` for each incoming ERP event
code, without hardcoded event codes in the source code.

**Why this priority**: Event mappings complete the "configuration over code" picture. P3 because
field mappings (P2) must work first; event mapping is a parallel concern but depends on the same
infrastructure.

**Independent Test**: Seed one tenant+ERP with one `event_mappings` row. Trigger a sync that
produces an ERP record with the mapped `erp_event_code`. Confirm the outbox payload contains the
correct `avimus_event_id`. Trigger a sync with an unmapped event code and confirm the record is
skipped with a WARN log.

**Acceptance Scenarios**:

1. **Given** an ERP record's event code matches an `event_mappings` row for the tenant+ERP,
   **When** the matcher processes the record,
   **Then** the outbox payload carries the corresponding `avimus_event_id`.

2. **Given** an ERP record's event code has no matching `event_mappings` row,
   **When** the matcher processes the record,
   **Then** the record is skipped, a WARN log is emitted with the unknown event code and the
   tenant/ERP context, and the cycle continues.

---

### Edge Cases

- What happens when the database is unreachable at the start of a cron tick?
  The cycle MUST fail fast, log an ERROR with the connection error, and not attempt any ERP calls.

- What happens when an ERP connection's credentials are malformed or decryption fails?
  That connection MUST be skipped with an ERROR log; other connections for the same or other
  tenants continue normally.

- What happens when a tenant has multiple active ERP connections?
  Each connection is processed independently in sequence within that tenant's iteration.

- What happens if a `field_mappings` row references a `source_field` that does not exist in the
  ERP record for a given tick?
  The missing field is treated as a null/absent value; it is NOT a fatal error, but IS logged at
  DEBUG level.

- What happens if two tenants share the same ERP base URL (legitimate scenario for shared
  on-premises installations)?
  Each `erp_connection` row is processed independently; shared URL is not a problem.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist tenant configuration in a `tenants` table with at minimum:
  `id`, `name`, `slug`, `is_active`, `created_at`.

- **FR-002**: The system MUST persist ERP connection configuration per tenant in an
  `erp_connections` table with at minimum: `id`, `tenant_id`, `erp_name`, `base_url`,
  `timeout_ms`, `credentials` (encrypted), `is_active`, `created_at`.

- **FR-003**: The system MUST persist field de-para configuration in a `field_mappings` table
  with at minimum: `id`, `tenant_id`, `erp_name`, `source_field`, `target_field`, `transform`,
  `created_at`; with a unique constraint on `(tenant_id, erp_name, source_field)`.

- **FR-004**: The system MUST persist event de-para configuration in an `event_mappings` table
  with at minimum: `id`, `tenant_id`, `erp_name`, `erp_event_code`, `avimus_event_id`,
  `description`, `created_at`; with a unique constraint on `(tenant_id, erp_name, erp_event_code)`.

- **FR-005**: The existing `sync_state`, `outbox`, and `audit_log` tables MUST gain a `tenant_id`
  column (nullable initially for backward compatibility with existing rows, NOT NULL for new rows).

- **FR-006**: The cron loop MUST query active tenants and their active ERP connections from the
  database at the start of each cycle, replacing the current environment-variable-driven
  single-tenant configuration.

- **FR-007**: The transformer MUST load `field_mappings` from the database for each
  `(tenant_id, erp_name)` pair and use them to build the outbox payload via direct 1:1 field
  copy (`source_field` → `target_field`); the `transform` column MUST be persisted but MUST NOT
  be evaluated in this feature; no field names MUST be hardcoded in business logic.

- **FR-008**: The matcher MUST load `event_mappings` from the database for each
  `(tenant_id, erp_name)` pair to resolve `erp_event_code` → `avimus_event_id`; no event codes
  MUST be hardcoded in business logic.

- **FR-009**: A tenant with `is_active = false` MUST be excluded from all sync processing.

- **FR-010**: An ERP connection with `is_active = false` MUST be excluded from all sync
  processing even if its parent tenant is active.

- **FR-011**: A `(tenant_id, erp_name)` pair with no `field_mappings` rows MUST produce a WARN
  log and be skipped for that cycle; it MUST NOT abort the processing of other pairs.

- **FR-012**: Every write to `outbox`, `sync_state`, and `audit_log` MUST include the correct
  `tenant_id`; writes without a `tenant_id` MUST be rejected at the application layer.

- **FR-013**: All database reads from `outbox`, `sync_state`, `audit_log`, `erp_connections`,
  `field_mappings`, and `event_mappings` MUST be scoped to a specific `tenant_id`; full-table
  scans without a `tenant_id` filter MUST NOT appear in business logic.

- **FR-014**: The existing mutex guard against overlapping cron cycles MUST remain in place and
  apply to the entire multi-tenant iteration loop. Within a cycle, all `(tenant, erp_connection)`
  pairs MUST be processed sequentially in a deterministic order (e.g., by tenant created_at,
  then by erp_connection created_at).

- **FR-015**: CPF values MUST remain masked in all log output (existing LGPD requirement).

- **FR-016**: Sensitive credential data in `erp_connections.credentials` MUST be encrypted at
  rest (extending the existing encryption pattern).

### Key Entities

- **Tenant**: Represents a hospital or clinic client. Identified by UUID. Has a human-readable
  `name` and a URL-safe `slug`. Can be activated or deactivated without deletion.

- **ERP Connection**: A configured connection to a specific ERP instance for a tenant. One tenant
  may have multiple ERP connections (one per ERP type). Carries the runtime parameters the adapter
  needs (base URL, timeout, credentials).

- **Field Mapping**: A de-para rule for a single source field in a specific ERP to a target field
  in the Ávimus payload, scoped to one tenant. The `transform` column is stored for future use
  but is not evaluated in this feature (1:1 direct copy only).

- **Event Mapping**: A de-para rule mapping an ERP-specific event code to an Ávimus
  `integrationEventId`, scoped to one tenant and ERP.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new hospital client can be fully onboarded (tenant record, ERP connection, field
  mappings, event mappings) without any code change or redeployment of the worker.

- **SC-002**: Adding a second active tenant causes the worker to process both tenants in the same
  cron cycle, with zero cross-tenant data leakage (verified by `tenant_id` on all output rows).

- **SC-003**: Deactivating a tenant causes it to be excluded from the very next cron cycle,
  without restarting the worker process.

- **SC-004**: A tenant with no `field_mappings` configured produces a WARN log and does not
  cause the cron cycle to abort for other tenants.

- **SC-005**: All outbox, sync_state, and audit_log rows written after the migration carry a
  non-null `tenant_id`; pre-existing rows without `tenant_id` remain untouched.

- **SC-006**: No field names or event codes from any specific ERP appear as string literals in
  business logic source files after this feature is complete.

## Assumptions

- The `integrations` schema already exists in PostgreSQL and the migration framework (raw SQL
  migrations or equivalent) is in place.
- Existing rows in `sync_state`, `outbox`, and `audit_log` are treated as legacy single-tenant
  data; the `tenant_id` column is added as nullable and existing rows are left with `NULL`.
- The `transform` column in `field_mappings` is created in the schema for future use but is not
  evaluated by the transformer in this feature; all field mapping is direct 1:1 copy. Transform
  function support is explicitly deferred to a future feature.
- Credential encryption uses the same mechanism already in place for the existing worker
  (AES-256 or equivalent via environment key).
- The worker process is restarted between migrations and feature activation; zero-downtime
  migration is not required for this feature.
- Only the Tasy adapter is in active use; the multi-tenant changes must not break the Tasy
  adapter's HTTP contract.
- There is no UI or API for managing tenants and mappings in this feature — database seeding
  and direct SQL are the only interfaces for now (the Worker HTTP API is Feature 003).
