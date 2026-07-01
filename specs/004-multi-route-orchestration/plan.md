# Implementation Plan: Multi-route ERP/Avimus Orchestration

**Branch**: `004-multi-route-orchestration` | **Date**: 2026-06-30 | **Spec**: [spec.md](spec.md)

## Summary

Evolução da arquitetura de integração para suportar múltiplos endpoints ERP por conexão, descoberta automática de campos via introspection síncrona, e múltiplas ações no Avimus (complete_step e start_journey) configuráveis por mapeamento de evento. Inclui migration de reset limpo das tabelas `field_mappings`, `event_mappings` e `sync_state` para a nova chave `endpoint_id`.

## Technical Context

**Language/Version**: TypeScript strict, Node.js 20+, ESM (`"type": "module"`)

**Primary Dependencies**: `pg` (node-postgres), `fastify` v5, `pino`, `zod`, `axios`, `node-cron` — sem novas dependências

**Storage**: PostgreSQL via Supabase, schema `integrations`. 3 migrations novas: `003_erp_endpoints.sql`, `004_migrate_mappings.sql`, `005_migrate_sync_state.sql`

**Testing**: `tsc --noEmit` (typecheck); testes manuais via curl conforme `quickstart.md`

**Target Platform**: Processo Node.js único (worker + HTTP API, porta 3003)

**Performance Goals**: Introspection síncrona ≤15s; throughput de sync inalterado

**Constraints**: Sem novas dependências npm; isolamento multi-tenant via JOIN obrigatório; `credentials` sempre criptografado; reset limpo na migration exige comunicação de downtime

**Scale/Scope**: N endpoints por connection (sem limite hard); ações Avimus extensíveis via map de handlers

## Constitution Check

| Princípio | Status | Observação |
|---|---|---|
| I. HTTP-Only Decoupling | ✅ | ERP via `fetch` nativo; Avimus via axios |
| II. ERP-Plugin Architecture | ✅ | `fetchEndpoint` sai do código e vai para o banco |
| III. Simplicity Over Engineering | ✅ | Map de handlers; sem plugins dinâmicos |
| IV. Observability | ✅ | audit_log por endpoint; correlationId em todas as ações |
| V. Data Resilience | ✅ | Outbox e audit_log preservados na migration |
| VI. Multi-tenant Isolation | ✅ | JOIN obrigatório: field_mappings → endpoint → connection → tenant |
| VII. Configuration over Code | ✅ | Endpoints, mappings e ações no banco |
| VIII. Admin as Consumer | ✅ | Novos endpoints da Worker API cobrem todas as operações |

## Project Structure

### Documentation (esta feature)

```
specs/004-multi-route-orchestration/
├── plan.md              ← este arquivo
├── research.md          ← decisões técnicas
├── data-model.md        ← schema SQL das tabelas novas/migradas
├── quickstart.md        ← sequência de validação (A–J)
├── contracts/
│   └── worker-api.md   ← contratos dos novos endpoints da Worker API
└── tasks.md             ← gerado por /speckit-tasks
```

### Source Code — arquivos afetados

```
src/
├── db/
│   ├── migrations/
│   │   ├── 003_erp_endpoints.sql          ← NOVA
│   │   ├── 004_migrate_mappings.sql       ← NOVA (reset limpo + endpoint_id)
│   │   └── 005_migrate_sync_state.sql     ← NOVA (endpoint_id em sync_state)
│   └── queries/
│       ├── erp-endpoints.ts               ← NOVO (CRUD de endpoints)
│       ├── field-mappings.ts              ← MODIFICADO (endpoint_id como chave)
│       ├── event-mappings.ts              ← MODIFICADO (endpoint_id + avimus_action)
│       └── sync-status.ts                 ← MODIFICADO (por endpoint)
├── services/
│   ├── tenant-orchestrator.ts             ← MODIFICADO (itera endpoints)
│   ├── poller.ts                          ← MODIFICADO (contexto por endpoint)
│   ├── transformer.ts                     ← MODIFICADO (lê field_mappings por endpoint)
│   └── avimus-actions/                    ← NOVO diretório
│       ├── index.ts                       ← map de handlers por avimus_action
│       ├── complete-step.ts               ← extraído do outbox-worker atual
│       └── start-journey.ts               ← NOVO
├── clients/
│   └── avimus.ts                          ← MODIFICADO (+ startJourney, checkJourney)
├── adapters/
│   ├── types.ts                           ← MODIFICADO (fetchEndpoint vira parâmetro de config)
│   └── tasy/index.ts                      ← MODIFICADO (path vem do endpoint, não hardcoded)
├── api/
│   └── routes/
│       ├── erp-endpoints.ts               ← NOVO
│       ├── erp-endpoint-field-mappings.ts ← NOVO (substitui field-mappings.ts antigo)
│       ├── erp-endpoint-event-mappings.ts ← NOVO (substitui event-mappings.ts antigo)
│       ├── field-mappings.ts              ← REMOVIDO (substituído)
│       ├── event-mappings.ts              ← REMOVIDO (substituído)
│       └── sync-status.ts                 ← MODIFICADO (resposta por endpoint)
│   └── server.ts                          ← MODIFICADO (registrar novas rotas)
└── config/
    └── erp-registry.ts                    ← MODIFICADO (não extrai fetchEndpoint — vem do endpoint)
```

## Ordem de implementação recomendada

### Fase 1 — Banco e migrations (bloqueante para tudo)
1. Criar migration `003_erp_endpoints.sql`
2. Criar migration `004_migrate_mappings.sql` (reset + nova estrutura)
3. Criar migration `005_migrate_sync_state.sql`
4. Aplicar migrations e verificar schema

### Fase 2 — Queries e cliente Avimus
5. Criar `src/db/queries/erp-endpoints.ts` (CRUD completo)
6. Atualizar `field-mappings.ts` para usar `endpoint_id`
7. Atualizar `event-mappings.ts` para usar `endpoint_id` + `avimus_action`
8. Atualizar `sync-status.ts` para agrupar por endpoint
9. Adicionar `startJourney` e `checkActiveJourney` em `clients/avimus.ts`

### Fase 3 — Ações Avimus e worker
10. Criar `src/services/avimus-actions/complete-step.ts` (extraído do outbox-worker)
11. Criar `src/services/avimus-actions/start-journey.ts`
12. Criar `src/services/avimus-actions/index.ts` (map de handlers)
13. Atualizar `outbox-worker.ts` para despachar por `avimus_action`
14. Atualizar `TasyAdapter` — `path` vem do endpoint, não hardcoded
15. Atualizar `tenant-orchestrator.ts` — itera por endpoint dentro de cada connection

### Fase 4 — Worker HTTP API
16. Criar `src/api/routes/erp-endpoints.ts` (CRUD + introspection)
17. Criar `src/api/routes/erp-endpoint-field-mappings.ts`
18. Criar `src/api/routes/erp-endpoint-event-mappings.ts`
19. Atualizar `server.ts` — registrar novas rotas, remover antigas
20. Atualizar `sync-status.ts` route — resposta por endpoint

### Fase 5 — Typecheck e validação
21. `npm run typecheck` — zero erros
22. Validação manual conforme `quickstart.md` (A–J)
