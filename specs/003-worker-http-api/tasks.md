---
description: "Task list for Feature 003 — Worker HTTP API"
---

# Tasks: Worker HTTP API

**Input**: Design documents from `specs/003-worker-http-api/`

**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ quickstart.md ✅

**Tests**: Não solicitados explicitamente — usar quickstart.md para validação manual.

**Organization**: Tasks agrupadas por user story para implementação e teste independentes.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Pode rodar em paralelo (arquivos diferentes, sem dependência de tarefas incompletas)
- **[Story]**: User story correspondente (US1, US2, US3, US4)
- Paths de arquivo exatos em toda descrição

---

## Phase 1: Setup

**Purpose**: Instalar única dependência nova e criar utilitários compartilhados.

- [x] T001 Instalar `fastify` como dependência de produção via `npm install fastify` no repo root

- [x] T002 [P] Criar `src/lib/mask.ts` — extrair `CPF_REGEX` e `maskCpf(value: string): string` de `src/lib/logger.ts`; em `logger.ts` substituir a definição local por re-export: `export { maskCpf } from './mask.js'`

- [x] T003 [P] Atualizar `.env.example` — adicionar `WORKER_API_PORT=3003`, `WORKER_API_SECRET=your-secret-here`, `DB_SCHEMA=integrations` com comentários explicativos

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Configuração, search_path fix, infraestrutura do servidor HTTP. BLOQUEIA todas as user stories.

**⚠️ CRITICAL**: Nenhuma user story pode começar até esta fase estar completa.

- [x] T004 Atualizar `src/config/index.ts` — adicionar ao `ConfigSchema` Zod: `workerApiPort: z.coerce.number().int().min(1).max(65535).default(3003)`, `workerApiSecret: z.string().min(1)` (obrigatório), `dbSchema: z.string().default('integrations')`; atualizar type `Config` correspondentemente

- [x] T005 Atualizar `src/db/index.ts` — após criar o `Pool`, adicionar `pool.on('connect', (client) => { void client.query(\`SET search_path TO \${config.dbSchema}\`); });` usando `getConfig()` — este é o fix crítico para search_path no Supabase (D8)

- [x] T006 [P] Criar `src/api/auth.ts` — exportar `buildAuthHook(secret: string)` que retorna um `onRequest` Fastify hook: se `request.url === '/health'` → retornar sem verificar; caso contrário extrair header `Authorization`, validar formato `Bearer <token>`, comparar token com `secret` via `timingSafeEqual` de `node:crypto`; se inválido → `reply.code(401).send({ error: 'Unauthorized' })`

- [x] T007 Criar `src/api/server.ts` — exportar `async function buildApiServer(pool: Pool, config: Config): Promise<FastifyInstance>`: criar instância Fastify com logger pino; registrar `contentTypeParser` para `application/json`; registrar handler de erro global retornando JSON com `{ error: string }`; registrar auth hook via `buildAuthHook(config.workerApiSecret)`; registrar todos os route plugins (health, tenants, erp-connections, field-mappings, event-mappings, sync-status, outbox) — cada plugin receberá `{ pool, config }` como opções; retornar instância

- [x] T008 Atualizar `src/index.ts` — após `loadConfig()` e `getPool()`: chamar `const api = await buildApiServer(pool, config)`; chamar `await api.listen({ port: config.workerApiPort, host: '0.0.0.0' })`; logar `{ port: config.workerApiPort }` com mensagem `'Worker HTTP API listening'`; no handler de shutdown adicionar `await api.close()` antes de `closePool()`

**Checkpoint**: `npm run typecheck` deve passar. Worker sobe sem erro (rotas retornam 404 até serem implementadas).

---

## Phase 3: User Story 1+4 — Tenants, Conexões ERP e Health Check (Priority: P1) 🎯 MVP

**Goal**: O admin consegue criar tenants, gerenciar conexões ERP e verificar o health da API.

**Independent Test**: Quickstart validações A (health), B (auth), C (tenant + conexão), I (soft delete), J (slug duplicado).

### Health Check (US4)

- [x] T009 [P] [US1] Criar `src/api/routes/health.ts` — plugin Fastify que registra `GET /health` sem auth: executar `pool.query('SELECT 1')` para testar conexão; retornar `200 { status: 'ok', database: 'connected', uptime_seconds: Math.floor(process.uptime()) }` se OK; capturar exceção e retornar `503 { status: 'degraded', database: 'disconnected', error: string }` se falhar

### Tenants (US1)

- [x] T010 [P] [US1] Atualizar `src/db/queries/tenants.ts` — adicionar: `getAllTenants(pool)` (`SELECT * FROM tenants ORDER BY created_at ASC`); `getTenantById(pool, id)` (`WHERE id = $1`, retorna `Tenant | null`); `createTenant(pool, { name, slug })` (`INSERT ... RETURNING *`, lançar erro com código `23505` para slug duplicado); `updateTenant(pool, id, { name?, is_active? })` (`UPDATE ... RETURNING *`, retorna `Tenant | null`)

- [x] T011 [US1] Criar `src/api/routes/tenants.ts` — plugin Fastify com prefixo `/tenants`: `GET /` → `getAllTenants`; `POST /` → `createTenant` com `201`; capturar erro de unique violation (PG code `23505`) e retornar `409 { error: 'Slug already exists' }`; `PATCH /:id` → `updateTenant`; retornar `404` se retornar null; todos os campos de resposta excluem campos internos; registrar este plugin em `src/api/server.ts`

### ERP Connections (US1)

- [x] T012 [P] [US1] Atualizar `src/db/queries/erp-connections.ts` — adicionar: `getAllConnections(pool, tenantId)` (`WHERE tenant_id = $1 ORDER BY created_at ASC`, inclui inativas); `createConnection(pool, input)` — criptografar `input.credentials` com `encrypt(credentials, encryptionKey)` antes do INSERT se não-null; retornar conexão sem `credentials`; `updateConnection(pool, tenantId, id, input)` — `WHERE id = $1 AND tenant_id = $2`; criptografar credentials se fornecida; `softDeleteConnection(pool, tenantId, id)` — `UPDATE SET is_active = false WHERE id = $1 AND tenant_id = $2`; retornar `boolean` (false se nenhuma row afetada)

- [x] T013 [US1] Criar `src/api/routes/erp-connections.ts` — plugin Fastify com prefixo `/tenants/:tenantId/erp-connections`: verificar que tenant existe via `getTenantById` (senão 404); `GET /` → `getAllConnections`; `POST /` → `createConnection` com `201`; `PATCH /:id` → `updateConnection`; `DELETE /:id` → `softDeleteConnection` (204 se ok, 404 se não encontrado); NUNCA incluir campo `credentials` nas respostas; registrar em `src/api/server.ts`

**Checkpoint**: Quickstart A–C, I, J validados. US1 + US4 completos e funcionais.

---

## Phase 4: User Story 2 — Mapeamentos de Campos e Eventos (Priority: P2)

**Goal**: O admin salva e consulta de-para de campos e eventos por tenant+ERP.

**Independent Test**: Quickstart validações D (field-mappings) e E (event-mappings).

- [x] T014 [P] [US2] Atualizar `src/db/queries/field-mappings.ts` — adicionar `replaceFieldMappings(pool, tenantId, erpName, mappings: FieldMappingInput[])`: obter `client = await pool.connect()`; executar em transação: `DELETE FROM field_mappings WHERE tenant_id = $1 AND erp_name = $2`; `INSERT INTO field_mappings ... VALUES (...)` para cada item do array (pode ser array vazio); `COMMIT`; retornar array `FieldMapping[]`; `ROLLBACK` em caso de erro

- [x] T015 [P] [US2] Atualizar `src/db/queries/event-mappings.ts` — adicionar `replaceEventMappings(pool, tenantId, erpName, mappings: EventMappingInput[])` com mesma semântica de transação DELETE+INSERT de T014

- [x] T016 [US2] Criar `src/api/routes/field-mappings.ts` — plugin Fastify com prefixo `/tenants/:tenantId/field-mappings`: verificar tenant (404 se não existe); `GET /:erpName` → `getFieldMappings`; `PUT /:erpName` → `replaceFieldMappings` com body `{ mappings: [...] }` (aceita array vazio); retornar `{ erp_name, mappings: [...] }`; registrar em `src/api/server.ts`

- [x] T017 [US2] Criar `src/api/routes/event-mappings.ts` — plugin Fastify com prefixo `/tenants/:tenantId/event-mappings`: mesma estrutura de T016 usando `replaceEventMappings` e `getEventMappings`; registrar em `src/api/server.ts`

**Checkpoint**: Quickstart D–E validados. US2 completo e testável independentemente.

---

## Phase 5: User Story 3 — Monitoramento e Retry (Priority: P3)

**Goal**: O admin consulta status de sincronização, lista o outbox com filtros e reprocessa falhas.

**Independent Test**: Quickstart validações F (sync-status) e G (outbox + retry).

- [x] T018 [US3] Criar `src/db/queries/sync-status.ts` — exportar `interface ErpSyncStatus` e `getSyncStatus(pool, tenantId, pollingIntervalMinutes)`: query SQL com LEFT JOIN entre `erp_connections`, `sync_state` e `audit_log` (WHERE `audit_log.timestamp >= date_trunc('day', now() AT TIME ZONE 'UTC')`); usar `SUM((details->>'fetched')::int) FILTER (WHERE action = 'sync_cycle.complete')` para `fetched_today` e `enqueued_today`; `COUNT(*) FILTER (WHERE action = 'delivery.success')` para `delivered_today`; `COUNT(*) FILTER (WHERE action = 'delivery.failed')` para `failed_today`; calcular `next_sync_at = last_synced_at + pollingIntervalMinutes minutos` em TypeScript; retornar `ErpSyncStatus[]`

- [x] T019 [P] [US3] Atualizar `src/db/queries/outbox.ts` — adicionar: `listOutbox(pool, { tenantId, status?, date?, limit, cursor? }): Promise<OutboxPage>` — cursor = `base64url(JSON.stringify({ t: created_at.toISOString(), i: id }))`; query: `WHERE tenant_id = $1 AND (status = $2 IF provided) AND (created_at >= $3 IF date provided) AND ((created_at, id) < (cursor_t, cursor_i) IF cursor provided) ORDER BY created_at DESC, id DESC LIMIT limit+1`; se retornou `limit+1` rows → `next_cursor` encodado do último; descriptografar `aggregate_id` com `decrypt()` e mascarar com `maskCpf()` em cada registro; `retryOutboxRecord(pool, tenantId, id): Promise<boolean>` — `UPDATE outbox SET status = 'pendente', attempt_count = 0, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'falhou'`; retornar `rowCount > 0`

- [x] T020 [US3] Criar `src/api/routes/sync-status.ts` — plugin Fastify: `GET /tenants/:tenantId/sync-status`; verificar tenant (404); chamar `getSyncStatus`; retornar `{ tenant_id, connections: [...] }`; registrar em `src/api/server.ts`

- [x] T021 [US3] Criar `src/api/routes/outbox.ts` — plugin Fastify com prefixo `/tenants/:tenantId/outbox`: verificar tenant (404); `GET /` com query params `status`, `date`, `limit` (validar `limit <= 100`, senão 400), `cursor`; chamar `listOutbox`; `POST /:id/retry` → chamar `retryOutboxRecord`; se retornar false → `409 { error: "Retry only allowed for records with status 'falhou'" }`; se true → `200 { id, status: 'pendente', attempt_count: 0 }`; registrar em `src/api/server.ts`

**Checkpoint**: Quickstart F–G validados. US3 completo. Todas as 4 user stories funcionais.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T022 [P] Rodar `npm run typecheck` (`tsc --noEmit`) — corrigir todos os erros TypeScript em arquivos novos e modificados: `src/api/`, `src/db/queries/`, `src/lib/mask.ts`, `src/config/index.ts`, `src/db/index.ts`, `src/index.ts`

- [x] T023 [P] Verificar isolamento multi-tenant — confirmar que todas as rotas em `src/api/routes/` que recebem `:tenantId` passam o `tenantId` do path param como filtro em TODAS as queries de banco (nenhuma query sem `WHERE tenant_id = $1`); rodar Quickstart H (isolamento)

- [ ] T024 Rodar validações completas do `quickstart.md` — A (health), B (auth), C (tenant+conexão), D (field-mappings), E (event-mappings), F (sync-status), G (outbox+retry), H (isolamento), I (soft delete), J (slug duplicado)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Sem dependências — iniciar imediatamente
- **Foundational (Phase 2)**: Depende de Phase 1 — BLOQUEIA todas as user stories
  - T004 deve preceder T005 (config.dbSchema usado no pool)
  - T006 pode rodar em paralelo com T004–T005
  - T007 depende de T006 (usa auth hook)
  - T008 depende de T007 (importa buildApiServer)
- **US1+US4 (Phase 3)**: Depende de Phase 2 completa
  - T009, T010, T012 podem rodar em paralelo
  - T011 depende de T010; T013 depende de T012
- **US2 (Phase 4)**: Depende de Phase 3 (tenant verificado nas rotas)
  - T014 e T015 em paralelo; T016 e T017 em paralelo após T014/T015
- **US3 (Phase 5)**: Depende de Phase 3
  - T018 e T019 podem rodar em paralelo
  - T020 depende de T018; T021 depende de T019
- **Polish (Phase 6)**: Depende de Phases 3–5

### Parallel Opportunities — Phase 2

```
T004 (config) → T005 (pool)
T006 (auth hook) — paralelo com T004/T005
T007 (server.ts) — após T006
T008 (index.ts) — após T007
```

### Parallel Opportunities — Phase 3

```
T009 (health route)     ← paralelo com T010, T012
T010 (tenants queries)  ← paralelo com T009, T012
T012 (erp-conn queries) ← paralelo com T009, T010
T011 (tenants routes)   ← após T010
T013 (erp-conn routes)  ← após T012
```

---

## Implementation Strategy

### MVP: US1 + US4 (P1)

1. Phase 1 (Setup)
2. Phase 2 (Foundational)
3. Phase 3 (US1 + US4)
4. **VALIDAR**: Quickstart A–C, I, J
5. Deploy/demo

### Entrega Incremental

1. Phase 1+2 → Infraestrutura pronta
2. Phase 3 → Health + Tenants + ERP Connections → **MVP!**
3. Phase 4 → Mapeamentos configuráveis
4. Phase 5 → Monitoramento e retry
5. Phase 6 → Endurecido para produção

---

## Notes

- `[P]` = arquivos diferentes, sem dependência compartilhada com tarefas incompletas
- T005 (search_path fix) é **pré-requisito crítico** para funcionar no Supabase — sem ele todas as queries falham
- T007 (server.ts) cria o servidor com importações das rotas; cada task de rota também atualiza o `server.ts` para registrar o plugin
- Testes não gerados (não solicitados) — usar quickstart.md para validação manual
- Total: 24 tarefas | US1+US4: 7 | US2: 4 | US3: 4 | Foundational: 5 | Setup: 3 | Polish: 3
