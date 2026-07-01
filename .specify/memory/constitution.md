<!-- Sync Impact Report
- Version change: 1.0.0 → 1.1.0
- Modified principles: None (all 5 originals preserved unchanged)
- Added sections: Principle VI (Multi-tenant Isolation), Principle VII (Configuration over Code), Principle VIII (Admin as Consumer)
- Removed sections: None
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ (Constitution Check section aligns; no structural changes needed)
  - .specify/templates/spec-template.md ✅ (Requirements section aligns; no structural changes needed)
  - .specify/templates/tasks-template.md ✅ (Task categorization aligns; no structural changes needed)
- Follow-up TODOs: None
-->

# Avimus Integrations Constitution

## Core Principles

### I. HTTP-Only Decoupling

All external communication MUST occur exclusively via HTTP/HTTPS.
No direct coupling with Ávimus, ERPs, or any external system is permitted
through shared libraries, SDKs, or direct imports.

- Integration adapters MUST communicate only through well-defined HTTP endpoints.
- No ERP-specific SDKs or client libraries in the core service.
- API contracts MUST be versioned independently of ERP implementations.

**Rationale**: Ensures the service remains a neutral integration layer,
independent of any specific ERP vendor or Ávimus internals.

### II. ERP-Plugin Architecture

New ERP integrations MUST be added as self-contained modules without
modifying core service code.

- Each ERP adapter lives in its own module/directory under `src/adapters/`.
- Adding a new ERP MUST require only: (a) implementing the adapter interface,
  (b) registering it in configuration.
- Core orchestration logic MUST NOT contain ERP-specific conditionals or logic.

**Rationale**: Enables independent development and testing of ERP integrations
without risking stability of the core service.

### III. Simplicity Over Engineering

Code MUST be simple, readable, and free of unnecessary abstraction layers.

- No premature optimization; prefer straightforward implementations.
- Avoid design patterns unless the problem genuinely requires them.
- Keep dependencies minimal; each dependency MUST justify its inclusion.
- Configuration MUST be explicit, not convention-based magic.

**Rationale**: Reduces cognitive load, eases onboarding, and minimizes the
surface area for bugs in a critical integration layer.

### IV. Observability

Every integration cycle step MUST produce structured, actionable logs.

- Log entries MUST include: timestamp, correlation ID, adapter name, operation,
  status, and relevant context (e.g., ERP identifier, record counts).
- Log levels MUST be used consistently: ERROR for failures requiring attention,
  WARN for degraded but recoverable states, INFO for normal operations,
  DEBUG for diagnostic detail.
- No silent failures; every error MUST be logged with sufficient context for
  diagnosis.

**Rationale**: Clear observability enables rapid debugging in a multi-ERP
environment where failures can originate from multiple external systems.

### V. Data Resilience

Integration failures MUST NOT result in data loss under any circumstances.

- Failed outbound requests MUST be persisted to a durable queue for retry.
- Retry mechanisms MUST implement exponential backoff with configurable limits.
- Dead-letter handling MUST capture permanently failed records for manual review.
- Idempotency keys MUST be used for all outbound calls to prevent duplicate
  processing.

**Rationale**: Integration services sit on critical data flows; a transient
failure in one ERP must not cause permanent data loss or inconsistency.

### VI. Multi-tenant Isolation

No tenant MAY access or affect data belonging to another tenant under any
circumstances.

- Every database query against `outbox`, `sync_state`, `audit_log`,
  `erp_connections`, `field_mappings`, and `event_mappings` MUST include a
  `tenant_id` filter.
- Tenants with `is_active = false` MUST be excluded from all sync cycles
  without exception.
- If no `field_mappings` exist for a given `(tenant_id, erp_name)` pair, the
  worker MUST log a warning and skip that tenant rather than falling back to
  a default mapping.
- Cross-tenant data visibility MUST be treated as a critical security defect.

**Rationale**: The platform serves multiple hospitals/clinics; a configuration
or query mistake that leaks one client's patient data into another's context
is a LGPD violation and an immediate business risk.

### VII. Configuration over Code

Field mappings and event mappings MUST live in the database, not in source
code or environment variables.

- The `field_mappings` table is the single source of truth for ERP-to-Ávimus
  field translation per tenant.
- The `event_mappings` table is the single source of truth for ERP event code
  to Ávimus event ID translation per tenant.
- Adding a new mapping for an existing tenant+ERP MUST require zero code
  changes and zero deploys.
- Hardcoded field or event mappings in application code are a constitution
  violation and MUST NOT be merged.

**Rationale**: Each hospital client may use different field names for
equivalent data in the same ERP. Encoding these differences in code would
require a deploy per client; database-driven configuration enables runtime
reconfiguration via the admin interface.

### VIII. Admin as Consumer

The patient-journey admin service (port 3002) is an HTTP client of the Worker
API (port 3003) and MUST NOT access the integrations database schema directly.

- All integration data reads and writes from the admin MUST go through the
  Worker API endpoints.
- The Worker API is the single enforcement point for data validation,
  multi-tenant isolation (Principle VI), and audit logging (Principle IV).
- The admin MUST NOT hold database credentials for the `integrations` schema.
- Any admin action that would require bypassing the Worker API MUST be
  escalated as an architectural decision, not implemented as a shortcut.

**Rationale**: Direct database access from the admin would bypass all
validation and isolation guarantees enforced by the worker. The Worker API
boundary ensures consistent enforcement of Principles IV, V, and VI
regardless of which client initiates the action.

## Technology Stack & Constraints

**Runtime**: Node.js 20+ with TypeScript (strict mode enabled).
**HTTP**: Use standard Node.js HTTP clients; no ERP-specific SDKs.
**Testing**: Unit tests for adapters, integration tests for HTTP contracts.
**Configuration**: Environment variables for operational parameters;
field/event mappings in the `integrations` schema (Principle VII).
**Build**: TypeScript compilation with strict type checking enforced.

Additional constraints:

- No direct database access for business logic from external consumers;
  persistence ONLY via the Worker API (port 3003, configurable via
  `WORKER_API_PORT`).
- All external calls MUST have configurable timeouts and retry policies.
- Service MUST expose health-check and readiness endpoints for operational
  monitoring.
- All queries against integration tables MUST include `tenant_id` (Principle VI).
- Worker API authentication uses a shared Bearer token (`WORKER_API_SECRET`);
  no per-user auth at the worker layer (the admin handles user auth upstream).

## Development Workflow

**Quality Gates**:

- All code MUST pass type checking (`tsc --noEmit`) before merge.
- All tests MUST pass; no skipped tests in the main branch.
- New ERP adapters MUST include contract tests for their HTTP interactions.
- Log output MUST be reviewed for clarity and completeness in PRs.
- PRs that touch database query code MUST be reviewed for missing `tenant_id`
  filters (Principle VI violation).

**PR Requirements**:

- PRs touching adapter code MUST include a brief integration-test scenario.
- PRs MUST reference the relevant ERP and operation type.
- Breaking changes to adapter interfaces MUST bump MAJOR version.
- PRs that add or modify field/event mappings MUST use the `field_mappings` or
  `event_mappings` tables, not hardcoded values (Principle VII).

**Release Process**:

- Semantic versioning (MAJOR.MINOR.PATCH) for the service package.
- Each release MUST include a changelog entry describing ERP-specific changes.
- Deployment MUST be accompanied by health-check validation.

## Governance

This constitution supersedes all other development practices for the
Avimus Integrations project. All pull requests and code reviews MUST verify
compliance with the principles above.

**Amendment Procedure**:

1. Propose change via PR with rationale and migration plan.
2. Review by at least one maintainer with domain expertise.
3. Update constitution version per semver rules.
4. Propagate changes to dependent templates and documentation.

**Versioning Policy**:

- MAJOR: Principle removal or incompatible redefinition.
- MINOR: New principle or section added; material expansion of existing guidance.
- PATCH: Wording clarifications, typo fixes, non-semantic refinements.

**Compliance Review**: Each sprint retrospective MUST include a brief
compliance check against constitution principles. Non-compliance MUST be
tracked as a blocking issue.

**Version**: 1.1.0 | **Ratified**: 2026-06-29 | **Last Amended**: 2026-06-30
