# Feature Specification: Tasy-Ávimus Sync

**Feature Branch**: `001-tasy-avimus-sync`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: "Serviço de integração multi-ERP. Node.js + TypeScript. Busca eventos do Tasy a cada 10 minutos, transforma e envia para Ávimus Patient Journey avançando steps de jornadas."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automated Event Sync Cycle (Priority: P1)

The integration service automatically polls the Tasy ERP every 10 minutes for new patient appointment records, transforms them into the format expected by the Ávimus Patient Journey API, and enqueues the results for delivery — advancing the corresponding steps in each patient's active journey.

**Why this priority**: This is the core value proposition. Without the automated sync cycle, the service has no purpose. This story alone delivers the end-to-end pipeline: fetch → transform → enqueue → deliver.

**Independent Test**: Can be fully tested by triggering a manual sync cycle and verifying that new Tasy records appear as completed steps in the Ávimus patient journeys within the configured polling interval.

**Acceptance Scenarios**:

1. **Given** the service is running with a configured Tasy ERP connection, **When** 10 minutes elapse since the last successful sync, **Then** the scheduler triggers a new polling cycle automatically.
2. **Given** a new appointment record exists in Tasy since the last sync, **When** the polling worker fetches recent records, **Then** the record is retrieved, transformed, and enqueued in the outbox with status "pendente".
3. **Given** multiple new records exist in Tasy, **When** the polling worker processes them, **Then** all records are enqueued before the `last_synced_at` timestamp is updated in the database.
4. **Given** a record is enqueued, **When** the outbox worker picks it up, **Then** the Ávimus step completion endpoint is called and the record status updates to "enviado" upon success.
5. **Given** the Ávimus API returns an error, **When** the outbox worker attempts delivery, **Then** the retry count increments and the record remains queued for the next attempt.

---

### User Story 2 - Failed Delivery Retry with Dead-Letter (Priority: P2)

When delivery to the Ávimus API fails, the system retries up to 3 times with exponential backoff. After exhausting retries, the record is marked as "falhou" and logged for manual review — ensuring no data is silently lost.

**Why this priority**: Resilience is critical for an integration layer. Without retry and dead-letter handling, transient failures would cause permanent data loss. This story ensures the system is production-ready.

**Independent Test**: Can be tested by simulating an Ávimus API outage and verifying that failed records are retried, then marked as "falhou" after 3 attempts, with clear error logs produced at each step.

**Acceptance Scenarios**:

1. **Given** an enqueued record and the Ávimus API is temporarily unavailable, **When** the outbox worker attempts delivery and receives an error, **Then** the attempt count increments and the record stays in "pendente" status.
2. **Given** a record has failed 3 delivery attempts, **When** the outbox worker processes it again, **Then** the status changes to "falhou" and an error is logged with the record details and failure reason.
3. **Given** a record is marked as "falhou", **When** the next polling cycle runs, **Then** the failed record is not retried automatically (manual intervention required).
4. **Given** multiple records fail delivery, **When** reviewing logs, **Then** each failure includes: timestamp, correlation ID, patient CPF, step ID, attempt number, and error message.

---

### User Story 3 - Patient Journey Matching (Priority: P3)

The transformer correctly matches incoming Tasy records to the right patient and active journey in Ávimus by CPF lookup, protocol matching, and integration event mapping — ensuring each Tasy event advances the correct step in the correct journey.

**Why this priority**: Correct matching is essential for data integrity. Without it, events could advance wrong steps or fail silently. This story ensures the transformation logic is accurate.

**Independent Test**: Can be tested with a known CPF, providing a Tasy record and verifying that the correct Ávimus patient, journey, and step are identified and returned in the payload.

**Acceptance Scenarios**:

1. **Given** a Tasy record with a valid CPF, **When** the transformer runs, **Then** the Ávimus patient is found via CPF search.
2. **Given** a patient with an active journey, **When** the transformer checks journey status, **Then** only journeys with status "ativo" are considered.
3. **Given** an active journey with a matching protocol, **When** the transformer verifies protocol alignment, **Then** the step whose `integration_event_id` matches the Tasy event's `erp_event_code` is identified.
4. **Given** no matching patient, journey, or step is found, **When** the transformer processes the record, **Then** the record is logged as "no match found" and is NOT enqueued.

---

### User Story 4 - ERP Adapter Extensibility (Priority: P4)

The codebase is structured so that adding support for a new ERP requires only implementing a new adapter module and registering it in configuration — no changes to the core orchestration, scheduling, or delivery logic.

**Why this priority**: Future-proofing. While not needed for v1, the architecture should make it trivial to add ERPs like TOTVS, Sankhya, or others without refactoring the core.

**Independent Test**: Can be verified by reviewing the adapter interface contract and confirming that a hypothetical second adapter could be added without modifying files outside its own module and the configuration.

**Acceptance Scenarios**:

1. **Given** the Tasy adapter implementation, **When** reviewing the adapter interface, **Then** it defines: `fetchRecentEvents(since: Date): Promise<RawEvent[]>` and any adapter can implement this contract.
2. **Given** a new ERP adapter is implemented, **When** the adapter is registered in the ERP registry configuration, **Then** the scheduler automatically includes it in the polling cycle.
3. **Given** the core orchestration code, **When** reviewing for ERP-specific logic, **Then** no ERP-specific conditionals or business rules exist outside the adapter modules.

---

### Edge Cases

- What happens when the Tasy API is unreachable during a polling cycle? The cycle logs the error and skips the update to `last_synced_at`, ensuring the same records are retried on the next cycle.
- What happens when the Ávimus API returns a 404 for a patient or step? The transformer logs "no match found" and does not enqueue the record.
- What happens when the database connection is lost? The service logs the error and retries the cycle on the next scheduled interval.
- What happens when a record's CPF is null or empty? The transformer skips the record and logs a warning.
- What happens when the `last_synced_at` value is null (first run)? The service performs an initial sync with a configurable lookback window (default: 24 hours).
- What happens when duplicate records exist in Tasy? The outbox uses idempotency to prevent duplicate step completions in Ávimus.
- What happens when a sync cycle takes longer than the polling interval? The scheduler skips the next cycle if the previous one is still running (mutex lock), preventing overlapping executions and potential duplicate enqueues.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST poll the Tasy ERP for new appointment records every 10 minutes (configurable via `POLLING_INTERVAL_MINUTES`).
- **FR-002**: System MUST persist `last_synced_at` per ERP in a database table and only update it after all records from a cycle are successfully enqueued.
- **FR-003**: System MUST transform Tasy appointment records into Ávimus step-completion payloads by: matching patient via CPF, finding active journeys, and mapping the correct step via `integration_event_id`.
- **FR-004**: System MUST enqueue transformed payloads in an outbox table with status "pendente" before attempting delivery.
- **FR-005**: System MUST deliver enqueued payloads to the Ávimus API via PATCH request and update status to "enviado" only upon receiving a 200 response.
- **FR-006**: System MUST retry failed deliveries up to 3 times before marking the record as "falhou".
- **FR-007**: System MUST log every sync cycle step: start, fetch count, transform results, enqueue count, delivery results, and cycle completion.
- **FR-008**: System MUST support adding new ERP adapters without modifying core orchestration logic.
- **FR-009**: System MUST authenticate with the Ávimus API using a Bearer token configured via environment variable.
- **FR-010**: System MUST NOT expose HTTP endpoints in this version.
- **FR-011**: System MUST skip records with null or invalid CPF and log a warning.
- **FR-012**: System MUST perform an initial lookback of 24 hours when `last_synced_at` is null (first run).
- **FR-013**: System MUST prevent overlapping sync cycles using a mutex lock — if a cycle is still running when the next one is scheduled, the new cycle MUST be skipped and logged.
- **FR-014**: System MUST encrypt sensitive data at rest (CPF, patient identifiers, API tokens) in the database.
- **FR-015**: System MUST mask CPF in all log outputs (show only last 3 digits, e.g., "***.456.789-**").
- **FR-016**: System MUST maintain an audit trail for all data access and modifications, including: timestamp, action performed, record identifier, and source (which component accessed the data).

### Key Entities

- **Sync State**: Tracks the last successful sync timestamp per ERP. Key attributes: ERP identifier, `last_synced_at` timestamp.
- **Outbox Record**: Represents a pending, sent, or failed delivery to Ávimus. Key attributes: ID, JSON payload, status (pendente/enviado/falhou), attempt count, created/updated timestamps.
- **Raw Tasy Event**: An appointment record fetched from the Tasy API. Key attributes: patient CPF, protocol ID, event code, event date, appointment details.
- **Ávimus Step Payload**: The formatted payload ready for delivery. Key attributes: step ID, result, notes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New Tasy appointment records appear as completed steps in Ávimus patient journeys within 15 minutes of creation in Tasy (including polling interval + processing time).
- **SC-002**: 100% of successfully transformed records are delivered to Ávimus or marked as "falhou" with clear error logs — no records stuck in "pendente" indefinitely.
- **SC-003**: Failed deliveries are retried and either succeed or are marked "falhou" within 5 minutes of the initial failure.
- **SC-004**: Adding a new ERP adapter requires changes only within the adapter's own module and configuration — zero modifications to core orchestration, scheduling, or delivery code.
- **SC-005**: Every sync cycle produces structured logs covering: cycle start/end, record counts per stage (fetched, transformed, enqueued, delivered, failed), and any errors encountered.
- **SC-006**: Zero data loss: records that fail delivery are persisted in the outbox and logged for manual review — never silently dropped.
- **SC-007**: LGPD compliance: CPF never appears in logs in full, sensitive data is encrypted at rest, and every data access is auditable via the trail.
- **SC-008**: Processing capacity: system handles up to 50 records per cycle within the 10-minute polling window without skipping cycles.

## Clarifications

### Session 2026-06-29

- Q: Ciclos sobrepostos devem ser impedidos, enfileirados ou permitidos rodar em concorrência? → A: Impedir sobreposição — se um ciclo ainda estiver rodando, o próximo é pulado (lock/mutex).
- Q: A v1 deve considerar requisitos básicos de LGPD? → A: Implementar criptografia em repouso, logs sem CPF completo, trilha de acesso completa.
- Q: Qual o volume esperado de novos atendimentos por ciclo de 10 minutos? → A: Médio (11-50 registros por ciclo).

## Assumptions

- The Tasy API at `http://192.168.80.190:9001/atendimentos/recentes` is reachable from the service's deployment environment.
- The Ávimus API endpoints (`/api/v1/patients`, `/api/v1/journeys`, `/api/v1/steps/{id}/complete`) are documented and stable.
- PostgreSQL is available and the service has read/write access to create the `sync_state` and `outbox` tables.
- The `AVIMUS_API_TOKEN` is a valid Bearer token with permission to search patients, list journeys, and complete steps.
- Tasy appointment records contain the required fields: CPF, protocol ID, event code, event date.
- The Ávimus `integration_event_id` on journey steps corresponds to the Tasy `erp_event_code`.
- Network latency between the service and both Tasy/Ávimus APIs is acceptable for 10-minute polling cycles.
- Expected volume: 11-50 new appointment records per 10-minute cycle in typical hospital environments.
- This is the initial version; HTTP endpoints, dashboards, and multi-ERP support are explicitly out of scope but the architecture accommodates future additions.
