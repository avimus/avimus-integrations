# Research: Tasy-Ávimus Sync

**Date**: 2026-06-29

## 1. Outbox Pattern

**Decision**: PostgreSQL outbox with `outbox_status` enum (`pendente`/`enviado`/`falhou`), `attempt_count INT`, `payload JSONB`, partial index `WHERE status = 'pendente'`, and `FOR UPDATE SKIP LOCKED` for worker queries.

**Rationale**: Matches spec naming (Portuguese statuses). Partial index keeps poll queries fast as historical rows accumulate. `FOR UPDATE SKIP LOCKED` enables safe row claiming and future multi-instance scaling.

**Alternatives considered**: Redis Streams (rejected — no Redis per constraints), separate retry table (rejected — over-engineered for 3 states).

## 2. Mutex / Overlapping Cycle Prevention

**Decision**: `pg_try_advisory_lock()` on a dedicated (non-pooled) PostgreSQL connection for cron-level mutex.

**Rationale**: Non-blocking (`try_` variant), auto-releases on connection close (crash safety), no external dependencies. Dedicated connection prevents pool recycling from orphaning the lock.

**Alternatives considered**: File-based locks (rejected — not suitable for containers), Redis locks (rejected — no Redis), in-memory boolean (rejected — not crash-safe).

**Key implementation detail**: Never use session-level advisory locks with PgBouncer transaction mode. If PgBouncer is added later, switch to `pg_try_advisory_xact_lock()`.

## 3. Exponential Backoff

**Decision**: Pure TypeScript utility with full jitter, `base=500ms`, `cap=10s`, `factor=2`, `maxAttempts=3`. Honors `Retry-After` headers. Supports `AbortSignal`.

**Rationale**: Full jitter prevents thundering-herd retries. Total worst-case wall time ~13.5s, well within 5-minute retry budget (SC-003). No external dependency per Constitution Principle III.

**Alternatives considered**: `p-retry` npm package (rejected — adds dependency for ~40 lines of code).

## 4. LGPD Compliance — CPF Masking

**Decision**: Pino `redact` for known field names (`cpf`, `documento`, etc.) + `safeLog()` wrapper with regex `/\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g` replacing with `***.XXX.XXX-**`.

**Rationale**: Double defense — field-name redaction handles structured data, regex handles CPF values appearing in unexpected places (JSON strings, etc.). Shows last 3 digits per FR-015.

**Alternatives considered**: Manual masking at each log call (rejected — error-prone, easy to forget).

## 5. LGPD Compliance — Encryption at Rest

**Decision**: `pgcrypto` extension with `pgp_sym_encrypt`/`pgp_sym_decrypt`. Encryption key from environment variable, stored as PostgreSQL session variable `app.encryption_key`. Encrypted column (`BYTEA`) for CPF, not JSONB.

**Rationale**: Database-level encryption is queryable, auditable in DB logs, and requires no extra application code. AES-256 under the hood. Key never in queries or logs.

**Alternatives considered**: Application-level AES encryption in Node.js (rejected — extra serialize/deserialize, hidden from DB audit trail).

## 6. Cron Scheduling

**Decision**: `node-cron` v4 (TypeScript-first, zero dependencies). One `ScheduledTask` per registered ERP, driven by per-ERP cron expression from config.

**Rationale**: Per-ERP scheduling allows different polling intervals. `ScheduledTask.stop()` used for graceful shutdown. No hardcoded `*/10 * * * *` — each ERP owns its schedule.

**Alternatives considered**: `cron` package (rejected — v4 node-cron is more TypeScript-native), custom `setInterval` (rejected — no cron expression support).

## 7. Adapter Plugin Architecture

**Decision**: Static `Record<string, Factory>` map in `src/config/erp-registry.ts`. Env var `ERP_NAMES` (comma-separated) selects active adapters. Each adapter implements `ErpAdapter` interface with `fetchRecentEvents(since: Date): Promise<RawEvent[]>`.

**Rationale**: Adding a new ERP = (1) implement `ErpAdapter` in `src/adapters/{name}/`, (2) add one factory entry in registry, (3) set env vars. Zero changes to core poller/transformer/delivery logic. Constitution Principle II satisfied.

**Alternatives considered**: Dynamic `import()` (rejected — breaks TypeScript narrowing, security risk), filesystem scan (rejected — no benefit for known adapter set).

## 8. Environment Variable Validation

**Decision**: Zod v4 with `safeParse` at startup. Crash immediately on invalid config with formatted error. Export typed `Config` object — no direct `process.env` access elsewhere.

**Rationale**: Fail-fast prevents silent misconfiguration discovered 10 minutes into operation. `z.coerce.number()` handles string-to-number conversion. ERP configs as JSON array env var.

**Alternatives considered**: Manual validation (rejected — verbose, error-prone), `envalid` package (rejected — Zod already needed for ERP config validation).

## 9. Graceful Shutdown

**Decision**: Centralized `SIGTERM`/`SIGINT` handler: stop cron tasks → abort in-flight HTTP via `AbortController` → `pool.end()` → hard timeout with `.unref()`.

**Rationale**: Prevents new work from starting, cancels in-flight requests, drains DB connections cleanly. Hard timeout prevents indefinite hangs.

**Alternatives considered**: `process.on('exit')` (rejected — cannot do async work), `death` package (rejected — unnecessary dependency).

## 10. Contract Testing

**Decision**: MSW (Mock Service Worker) + Vitest. MSW intercepts at HTTP level (patches Node `http`/`https`), so adapter's axios calls hit MSW instead of real ERP.

**Rationale**: Tests the HTTP contract (request shape, response mapping, error classification), not the implementation detail (axios). Same handlers work in dev, test, and E2E. Fast cold start.

**Alternatives considered**: `jest.mock('axios')` (rejected — tests implementation, not contract), nock (acceptable but MSW more actively maintained).

## 11. pg Pool Configuration

**Decision**: Single `Pool` instance created at startup, `max: 10`, `keepAlive: true`, `statement_timeout: 30s`, `idleTimeoutMillis: 30s`. Error handler on pool for idle client errors. `pool.end()` on shutdown.

**Rationale**: Background service needs fewer connections than HTTP server. `keepAlive` prevents cloud LB from killing idle TCP. `statement_timeout` prevents runaway queries. Error handler mandatory per pg docs.

## 12. Testing Framework

**Decision**: Vitest for unit, integration, and contract tests. Zero-config TypeScript, fast execution, native ESM support.

**Rationale**: Matches Constitution Principle III (simplicity). Vitest is faster than Jest for TypeScript projects. MSW integration is seamless.

## Dependencies Summary

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.4+ | Language |
| `pg` | ^8.x | PostgreSQL client |
| `node-cron` | ^4.x | Scheduler |
| `axios` | ^1.x | HTTP client |
| `zod` | ^4.x | Config validation |
| `pino` | ^9.x | Structured logging |
| `dotenv` | ^16.x | Env file loading |
| `vitest` | ^2.x | Testing (dev) |
| `msw` | ^2.x | HTTP mocking (dev) |
