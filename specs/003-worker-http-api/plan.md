# Implementation Plan: Worker HTTP API

**Branch**: `003-worker-http-api` | **Date**: 2026-06-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-worker-http-api/spec.md`

## Summary

Adicionar um servidor HTTP Fastify ao processo Node.js existente do worker, expondo 18 endpoints REST para que o admin (3002) possa gerenciar tenants, conexões ERP, mapeamentos e monitorar sincronizações. A API compartilha o pool pg do worker e é protegida por Bearer token único (`WORKER_API_SECRET`). Nenhuma tabela nova é criada; toda a persistência reutiliza o schema da Feature 002.

## Technical Context

**Language/Version**: Node.js 20+, TypeScript strict
**Primary Dependencies**: Fastify v5 (nova), pg (existente), pino (existente), zod (existente)
**Storage**: PostgreSQL — schema `integrations` (Supabase, sem ORM)
**Testing**: Vitest + Fastify `inject()` para testes de rota
**Target Platform**: Processo Node.js único (worker + API na mesma instância)
**Performance Goals**: P95 < 500ms para listagens de até 1.000 registros; health < 200ms
**Constraints**: Um único novo pacote npm (`fastify`); sem Redis, sem ORM; pool pg compartilhado
**Scale/Scope**: Single-instance; único consumidor (admin 3002 server-side)

## Constitution Check

| Princípio | Gate | Status |
|---|---|---|
| I. HTTP-Only Decoupling | API exposta via HTTP; sem SDK externo | PASS |
| II. ERP-Plugin Architecture | Feature não altera adapters | PASS |
| III. Simplicity Over Engineering | Um framework, um middleware, zero abstração extra | PASS |
| IV. Observability | Access log estruturado com correlation ID em cada request | PASS |
| V. Data Resilience | Retry endpoint restaura registro para re-processamento | PASS |
| VI. Multi-tenant Isolation | Toda query inclui tenant_id do path param como filtro | PASS |
| VII. Configuration over Code | Mapeamentos lidos e escritos via DB; nenhum hardcoded | PASS |
| VIII. Admin as Consumer | Esta feature implementa diretamente a Worker API | PASS |

Sem violações.

## Key Design Decisions

| ID | Decisão |
|---|---|
| D1 | Fastify v5: TypeScript nativo, ESM-clean, uma dependência |
| D2 | Mesmo processo + pool compartilhado: `buildApiServer(pool, config)` injetado de `index.ts` |
| D3 | Auth: `onRequest` hook global com exceção `/health`; `timingSafeEqual` para o token |
| D4 | Cursor opaco base64url com `(created_at, id)` para paginação estável |
| D5 | CPF mascarado via `lib/mask.ts` (extraído de `logger.ts`) ao descriptografar `aggregate_id` |
| D6 | Sync-status via JOIN `sync_state` + `audit_log` — contadores UTC por `erp_name` |
| D7 | PUT mappings = DELETE+INSERT em transação — substituição integral atômica |
| D8 | `DB_SCHEMA` + `search_path` no pool `connect` event — fix crítico para Supabase |

## Project Structure

### Documentation

```text
specs/003-worker-http-api/
├── plan.md          ← este arquivo
├── research.md      ← decisões D1-D8
├── data-model.md    ← interfaces TS + novos módulos de query
├── quickstart.md    ← validações A-J
└── tasks.md         ← gerado por /speckit-tasks
```

### Source Code (novos e modificados)

```text
src/
├── api/
│   ├── server.ts                    ← NEW
│   ├── auth.ts                      ← NEW
│   └── routes/
│       ├── health.ts                ← NEW
│       ├── tenants.ts               ← NEW
│       ├── erp-connections.ts       ← NEW
│       ├── field-mappings.ts        ← NEW
│       ├── event-mappings.ts        ← NEW
│       ├── sync-status.ts           ← NEW
│       └── outbox.ts                ← NEW
├── db/
│   └── queries/
│       ├── tenants.ts               ← MODIFIED
│       ├── erp-connections.ts       ← MODIFIED
│       ├── field-mappings.ts        ← MODIFIED
│       ├── event-mappings.ts        ← MODIFIED
│       ├── outbox.ts                ← MODIFIED
│       └── sync-status.ts           ← NEW
├── lib/
│   └── mask.ts                      ← NEW (extraído de logger.ts)
├── config/
│   └── index.ts                     ← MODIFIED: + workerApiPort, workerApiSecret, dbSchema
├── db/
│   └── index.ts                     ← MODIFIED: + search_path via pool.on('connect')
└── index.ts                         ← MODIFIED: + api server start/stop
```
