# Tasks: Multi-route ERP/Avimus Orchestration

**Branch**: `004-multi-route-orchestration`  
**Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Data Model**: [data-model.md](data-model.md)  
**Contracts**: [contracts/worker-api.md](contracts/worker-api.md) | **Quickstart**: [quickstart.md](quickstart.md)

---

## Phase 1: Setup

**Purpose**: Verificar que o ambiente está pronto antes das migrations.

- [X] T001 Verificar que `npm run typecheck` passa no estado atual antes de qualquer mudança
- [X] T002 [P] Criar arquivo `src/db/migrations/003_erp_endpoints.sql` com CREATE TABLE erp_endpoints conforme data-model.md
- [X] T003 [P] Criar arquivo `src/db/migrations/004_migrate_mappings.sql` com reset limpo de field_mappings e event_mappings + adição de endpoint_id + coluna avimus_action em event_mappings
- [X] T004 [P] Criar arquivo `src/db/migrations/005_migrate_sync_state.sql` com adição de endpoint_id em sync_state e remoção de erp_name

**Checkpoint**: Migrations escritas — revisar SQL antes de aplicar.

---

## Phase 2: Foundational (Migrations — Bloqueante para todos os User Stories)

**Purpose**: Aplicar as migrations e garantir que o schema está correto. Nenhuma user story pode ser implementada antes deste ponto.

**⚠️ CRÍTICO**: Reset limpo remove dados de `field_mappings` e `event_mappings`. Comunicar downtime antes de rodar.

- [ ] T005 Executar `npm run db:migrate` e verificar que as 3 migrations foram aplicadas sem erros
- [ ] T006 Verificar schema no banco: confirmar que `erp_endpoints` existe, `field_mappings` tem `endpoint_id`, `event_mappings` tem `endpoint_id` + `avimus_action`, `sync_state` tem `endpoint_id`

**Checkpoint**: Schema correto no banco — user stories podem iniciar.

---

## Phase 3: User Story 1 — Múltiplos endpoints por conexão ERP (Priority: P1) 🎯 MVP

**Goal**: O worker itera por endpoints dentro de cada connection; a Worker API expõe CRUD completo de endpoints com field_mappings e event_mappings próprios por endpoint.

**Independent Test**: Criar dois endpoints para a mesma connection via API; verificar que cada um tem field_mappings e event_mappings isolados; verificar que o worker itera ambos no ciclo de sync.

### Queries e DB

- [X] T007 [P] [US1] Criar `src/db/queries/erp-endpoints.ts` com: `getActiveEndpoints(pool, connectionId)`, `getAllEndpoints(pool, tenantId, connectionId)`, `createEndpoint(pool, input)`, `updateEndpoint(pool, tenantId, connId, id, input)`, `softDeleteEndpoint(pool, tenantId, connId, id)` — todas as queries validam `tenant_id` via JOIN em `erp_connections`
- [X] T008 [P] [US1] Reescrever `src/db/queries/field-mappings.ts`: substituir `(tenant_id, erp_name)` por `endpoint_id` como chave; adicionar validação de tenant via JOIN (`endpoint → connection → tenant_id = $tenantId`); manter `getFieldMappings`, `replaceFieldMappings` com nova assinatura
- [X] T009 [P] [US1] Reescrever `src/db/queries/event-mappings.ts`: substituir `(tenant_id, erp_name)` por `endpoint_id`; adicionar coluna `avimus_action` no SELECT e INSERT; validar tenant via JOIN; manter `getEventMappings`, `replaceEventMappings`

### Adapter e worker

- [X] T010 [US1] Atualizar `src/adapters/types.ts`: remover `readonly fetchEndpoint: string` da interface `ErpAdapter` (o path agora vem do endpoint do banco, não do adapter)
- [X] T011 [US1] Atualizar `src/adapters/tasy/index.ts`: remover `readonly fetchEndpoint` e a constante hardcoded `/eventos/start_protocolo`; o construtor recebe `path: string` no config e o usa em `fetchRecentEvents`
- [X] T012 [US1] Atualizar `src/config/erp-registry.ts`: remover `ADAPTER_METADATA` e `getAdapterMetadata`; `createAdapter` recebe `path: string` adicional e passa ao TasyAdapter; remover extração de `fetchEndpoint`
- [X] T013 [US1] Atualizar `src/services/types.ts`: adicionar `endpoint` (tipo `ErpEndpoint`) ao `TenantErpContext` ao lado de `connection`
- [X] T014 [US1] Atualizar `src/services/tenant-orchestrator.ts`: para cada `connection`, buscar `getActiveEndpoints(pool, connection.id)`; para cada endpoint, criar adapter com `path = endpoint.path` e `token` das credentials do endpoint (com fallback para credentials da connection); montar `TenantErpContext` com o endpoint; chamar `runSyncCycle`
- [X] T015 [US1] Atualizar `src/services/poller.ts`: o `runSyncCycle` recebe contexto com `endpoint`; usar `endpoint.id` como chave em `getLastSyncedAt` e `updateSyncState`; o `eventId` do adapter é prefixado com `endpoint.path` para garantir unicidade entre endpoints
- [X] T016 [US1] Atualizar `src/services/transformer.ts`: buscar `getFieldMappings(pool, endpoint.id)` e `getEventMappings(pool, endpoint.id)` em vez de `(tenant_id, erp_name)`

### Worker API — novos endpoints

- [X] T017 [US1] Criar `src/api/routes/erp-endpoints.ts`: `GET /tenants/:tenantId/erp-connections/:connId/endpoints`, `POST` (cria, `credentials` criptografado), `PATCH /:endpointId` (atualiza, `credentials` criptografado), `DELETE /:endpointId` (soft-delete, retorna 204)
- [X] T018 [US1] Criar `src/api/routes/erp-endpoint-field-mappings.ts`: `GET /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/field-mappings`, `PUT` (replace all) — valida tenant via JOIN antes de qualquer operação
- [X] T019 [US1] Criar `src/api/routes/erp-endpoint-event-mappings.ts`: `GET` e `PUT` com mesmo padrão — inclui `avimus_action` no response e body; validar que `avimus_action` é `complete_step` ou `start_journey`; para `complete_step`, `avimus_event_id` é obrigatório
- [X] T020 [US1] Atualizar `src/api/server.ts`: registrar as 3 novas rotas acima; remover registro das rotas antigas `fieldMappingRoutes` e `eventMappingRoutes` (keyed por erp_name)
- [X] T021 [US1] Remover `src/api/routes/field-mappings.ts` e `src/api/routes/event-mappings.ts` (substituídos pelas rotas por endpoint)

**Checkpoint**: Criar dois endpoints via API, configurar field_mappings distintos para cada um, verificar que o worker itera ambos no próximo ciclo.

---

## Phase 4: User Story 2 — Descoberta automática de campos (Priority: P2)

**Goal**: O admin aciona `POST .../introspect` e recebe os nomes dos campos do ERP sem digitar nada.

**Independent Test**: Acionar introspect para um endpoint configurado; receber lista de campos do ERP em ≤15s; acionar para ERP inacessível e receber 504 com mensagem descritiva.

- [X] T022 [US2] Criar `src/lib/field-introspector.ts`: função `introspectEndpoint({ baseUrl, path, token, timeoutMs })` que faz `fetch` no ERP com timeout de 15s; extrai o primeiro objeto do array retornado; aplica `flattenKeys(obj, '', 0, maxDepth=2)` para achatar campos aninhados com notação de ponto; retorna `string[]` com os nomes de campos; em caso de timeout ou erro de rede, lança `IntrospectionError` com mensagem descritiva
- [X] T023 [US2] Adicionar `POST /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/introspect` em `src/api/routes/erp-endpoints.ts`: busca o endpoint e a connection do banco (validando tenant); chama `introspectEndpoint` com `baseUrl` da connection + `path` e `token` do endpoint; retorna `{ endpoint_id, path, fetch_url, fields: string[] }`; em caso de `IntrospectionError`, retorna `504` com o erro descritivo

**Checkpoint**: `POST .../introspect` retorna campos reais do ERP; `504` quando ERP inacessível.

---

## Phase 5: User Story 3 — Múltiplas ações no Avimus (Priority: P2)

**Goal**: O worker executa a ação correta no Avimus (`complete_step` ou `start_journey`) conforme o `avimus_action` do event_mapping. A ação `start_journey` cria jornada com `cpf` + `protocolId` e verifica existência antes.

**Independent Test**: Configurar event_mapping com `avimus_action = 'start_journey'`; processar evento; verificar que o worker chama `POST /api/v1/journeys` no Avimus e não `PATCH /steps/:id/complete`.

### Cliente Avimus

- [X] T024 [US3] Adicionar em `src/clients/avimus.ts`: `checkActiveJourney(cpf, protocolId): Promise<AvimusJourney | null>` — `GET /api/v1/journeys?cpf=&protocolId=&status=ativo`; `startJourney(cpf, protocolId): Promise<AvimusJourney>` — `POST /api/v1/journeys` com `{ cpf, protocolId }`; adicionar tipos `AvimusJourney` se ainda não existirem

### Handlers de ação

- [X] T025 [US3] Criar `src/services/avimus-actions/complete-step.ts`: extrair a lógica atual de `completeStep` do `outbox-worker.ts`; exportar `completeStepAction(record, payload, signal): Promise<void>`
- [X] T026 [US3] Criar `src/services/avimus-actions/start-journey.ts`: exportar `startJourneyAction(record, payload, signal): Promise<void>` — extrai `cpf` e `protocolId` do payload; chama `checkActiveJourney`; se já existe, loga skip e retorna; se não, chama `startJourney`; se Avimus retornar 404 ou endpoint não existir, lança erro descritivo
- [X] T027 [US3] Criar `src/services/avimus-actions/index.ts`: exportar `ACTION_HANDLERS: Record<string, AvimusActionHandler>` com `{ complete_step: completeStepAction, start_journey: startJourneyAction }`; exportar tipo `AvimusActionHandler`

### Atualizar outbox-worker

- [X] T028 [US3] Atualizar `src/db/queries/outbox.ts`: o payload do outbox ao ser enfileirado (`enqueue`) deve incluir `avimus_action` (vindo do event_mapping); atualizar `EnqueueInput` e `OutboxRecord` para carregar `avimus_action` — implementado via campo JSONB payload (sem nova coluna)
- [X] T029 [US3] Atualizar `src/services/outbox-worker.ts`: em `processPendingDeliveries`, ler `payload.avimus_action` (default `'complete_step'` para retrocompatibilidade); buscar handler em `ACTION_HANDLERS[avimus_action]`; se handler não encontrado, marcar como `falhou` com erro `Unknown avimus_action`; remover lógica de `completeStep` inline (agora em `complete-step.ts`)

**Checkpoint**: Dois event_mappings com ações diferentes processam eventos distintos corretamente; ação desconhecida gera `falhou` no outbox.

---

## Phase 6: User Story 4 — Visibilidade de rotas e ações (Priority: P3)

**Goal**: O sync-status retorna contadores por endpoint (não só por erp_name); a admin pode ver `fetch_url` e `avimus_action` de cada mapeamento sem abrir código.

**Independent Test**: Consultar sync-status com dois endpoints ativos; verificar que a resposta agrupa por connection → endpoints com `fetch_url` e contadores individuais.

- [X] T030 [US4] Reescrever `src/db/queries/sync-status.ts`: query agrupada por `endpoint_id` em vez de `erp_name`; JOIN: `erp_connections → erp_endpoints → sync_state + audit_log`; retornar `base_url` da connection e `path` do endpoint; calcular `fetch_url = base_url + path`; contadores do dia por endpoint via audit_log
- [X] T031 [US4] Atualizar `src/api/routes/sync-status.ts`: adaptar resposta ao contrato definido em `contracts/worker-api.md` — objeto por connection contendo array de endpoints, cada um com `endpoint_id`, `path`, `fetch_url`, `is_active`, `last_synced_at`, `next_sync_at`, `today`

**Checkpoint**: `GET /tenants/:id/sync-status` retorna endpoints individuais com fetch_url e contadores separados.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T032 Executar `npm run typecheck` — zero erros de TypeScript em todo o projeto
- [ ] T033 [P] Atualizar `docs/technical-guide.md`: seção de API com novos endpoints (erp-endpoints, introspect, field/event mappings por endpoint); seção de data model com erp_endpoints; remover referências às rotas antigas por erp_name
- [X] T034 [P] Remover importação de `getAdapterMetadata` de `src/db/queries/sync-status.ts` — não necessário, sync-status foi completamente reescrito sem essa dependência
- [ ] T035 Validação manual conforme `quickstart.md` — cenários A até J com worker rodando

---

## Dependencies & Execution Order

### Dependências entre fases

```
Phase 1 (Setup/Migrations escritas)
    ↓
Phase 2 (Migrations aplicadas) ← BLOQUEANTE
    ↓
Phase 3 (US1) ← Bloqueante para US2, US3, US4 (queries e rotas dependem do schema)
    ↓           ↘
Phase 4 (US2)   Phase 5 (US3)  ← podem rodar em paralelo após US1
    ↓           ↙
Phase 6 (US4)  ← depende de sync-status query (T030) que usa erp_endpoints
    ↓
Phase 7 (Polish)
```

### Dependências dentro do US1

```
T007, T008, T009 [P] — queries (arquivos diferentes, paralelas)
    ↓
T010, T011, T012 [P] — adapter/registry (arquivos diferentes, paralelas após T007)
    ↓
T013 — types.ts (base para orchestrator)
    ↓
T014 — tenant-orchestrator.ts
    ↓
T015, T016 — poller.ts e transformer.ts (podem rodar em paralelo)
    ↓
T017, T018, T019 [P] — rotas API (arquivos diferentes, paralelas)
    ↓
T020 — server.ts (registra todas as rotas acima)
    ↓
T021 — remover arquivos antigos
```

---

## Parallel Example: US1

```bash
# Rodar em paralelo (arquivos diferentes):
Task T007: src/db/queries/erp-endpoints.ts
Task T008: src/db/queries/field-mappings.ts
Task T009: src/db/queries/event-mappings.ts

# Depois, em paralelo:
Task T017: src/api/routes/erp-endpoints.ts
Task T018: src/api/routes/erp-endpoint-field-mappings.ts
Task T019: src/api/routes/erp-endpoint-event-mappings.ts
```

---

## Implementation Strategy

### MVP (US1 apenas)

1. Completar Phase 1 + Phase 2 (migrations)
2. Completar Phase 3 — US1
3. **PARAR e VALIDAR**: dois endpoints funcionando com mapeamentos independentes
4. Worker iterando ambos os endpoints no ciclo de sync

### Entrega incremental

1. US1 → endpoints múltiplos + CRUD API ← mínimo para o admin configurar
2. US2 → introspection ← onboarding mais rápido
3. US3 → múltiplas ações ← start_journey desbloqueado
4. US4 → visibilidade ← monitoring completo

---

## Summary

| Fase | Tarefas | Status |
|---|---|---|
| Phase 1 — Setup | T001–T004 | ✅ Completo |
| Phase 2 — Migrations | T005–T006 | ⏳ Requer `npm run db:migrate` |
| Phase 3 — US1 (P1) | T007–T021 | ✅ Completo |
| Phase 4 — US2 (P2) | T022–T023 | ✅ Completo |
| Phase 5 — US3 (P2) | T024–T029 | ✅ Completo |
| Phase 6 — US4 (P3) | T030–T031 | ✅ Completo |
| Phase 7 — Polish | T032–T035 | T033+T035 pendentes |

**Total implementado**: 33/35 tarefas | **Pendentes**: T005-T006 (DB), T033 (docs), T035 (validação manual)
