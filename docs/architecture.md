# Arquitetura — Avimus Integrations

## Visão Geral

Serviço background Node.js/TypeScript que sincroniza eventos de ERPs (atualmente Tasy) com a plataforma Ávimus Patient Journey. O serviço não expõe endpoints HTTP e opera exclusivamente por polling + outbox pattern.

```
┌─────────────┐        ┌──────────────────────────────────────────────┐        ┌─────────────┐
│  Tasy ERP   │◄──HTTP─┤  Poller (node-cron)                         │        │  Ávimus API │
│  /atend...  │        │  ↓ fetchRecentEvents()                      │        │  /steps/... │
└─────────────┘        │  ↓ transformEvent() → matchPatient/Journey  │──HTTP─►│  PATCH      │
                       │  ↓ enqueue() → outbox table (PostgreSQL)    │        └─────────────┘
                       │                                             │
                       │  Outbox Worker (node-cron, every minute)   │
                       │  ↓ claimPending()                          │
                       │  ↓ completeStep() via withRetry()          │
                       │  ↓ markSent() / markFailed()               │
                       └──────────────────────────────────────────────┘
```

## Componentes

### `src/index.ts` — Entry Point

- Carrega configuração e valida env vars via Zod
- Registra adapters via `resolveActiveAdapters()`
- Agenda cron jobs: um por ERP (polling) + um global (outbox delivery)
- Gerencia graceful shutdown: hard-exit timeout → para crons → abort HTTP → fecha pool

### `src/adapters/` — Plugin ERP

Cada ERP é um módulo isolado implementando `ErpAdapter`:

```typescript
interface ErpAdapter {
  readonly name: string;
  fetchRecentEvents(since: Date): Promise<RawEvent[]>;
}
```

Adicionar novo ERP = criar `src/adapters/{nome}/index.ts` + registrar em `erp-registry.ts`. Zero mudanças no core. Ver [ADDING_ERPS.md](../ADDING_ERPS.md).

### `src/services/poller.ts` — Orquestrador de Ciclo

Executa o pipeline fetch → transform → enqueue em lotes paralelos de 5 eventos. Atualiza `last_synced_at` com o timestamp de **início do fetch** (não do final) para evitar gap de eventos durante o processamento.

### `src/services/transformer.ts` — Transformação

Valida CPF, chama o matcher, constrói o payload `CompleteStepPayload`. Retorna `null` para records sem match (log + skip, sem enqueue).

### `src/services/matcher.ts` — Matching CPF → Step

Pipeline: `searchPatient(cpf)` → `listJourneys(patientId)` → `listSteps(journeyId)`. Retorna `null` em qualquer etapa que falhe. Não lança exceção para ausência de match.

### `src/services/outbox-worker.ts` — Delivery Worker

- Chama `completeStep()` com `withRetry(maxAttempts = config.maxRetries)`
- `withRetry` é o **único** mecanismo de retry (sem outer attempt loop)
- 404/401/403 → falha permanente imediata (`markFailed`)
- Erros transitórios → backoff exponencial com jitter
- Idempotência: checa `hasRecentSuccess` antes de cada entrega

### `src/lib/crypto.ts` — Criptografia (LGPD / FR-014)

AES-256-GCM determinístico (IV derivado de HMAC-SHA256 do plaintext). Permite queries de igualdade no banco. Usado em `outbox.aggregate_id` (CPF do paciente).

### `src/lib/mutex.ts` — Advisory Lock

`pg_try_advisory_lock` garante que apenas um worker por ERP rode simultâneamente, mesmo com múltiplas instâncias do serviço. Lock ID é derivado do nome do adapter via hash para evitar colisões entre ERPs.

### `src/lib/backoff.ts` — Retry com Jitter

Full-jitter exponential backoff. Suporta `AbortSignal`, `Retry-After` header, e `shouldRetry` customizável. Não retenta 404/401/403 por padrão.

## Fluxo de Dados

```
[Tasy API]
    │
    │ GET /atendimentos/recentes?since=...
    ▼
[TasyAdapter.fetchRecentEvents()]
    │ → RawEvent[]
    ▼
[transformEvent()]
    │ → findMatchingStep(cpf, erpEventCode)
    │     → searchPatient(cpf)      [Ávimus API]
    │     → listJourneys(patientId) [Ávimus API]
    │     → listSteps(journeyId)    [Ávimus API]
    │ → CompleteStepPayload
    ▼
[enqueue()] → outbox table (aggregate_id = encrypt(CPF))
    │
    │ (next cron tick — up to 1 minute later)
    ▼
[claimPending()] → decrypt(aggregate_id) → OutboxRecord[]
    │
[completeStep(stepId, payload)] → PATCH /api/v1/steps/{id}/complete
    │
    ├── 200 OK → markSent()
    └── Error → withRetry() → ... → markFailed()
```

## Banco de Dados

```
sync_state       — last_synced_at por ERP (controla janela de polling)
outbox           — fila de entregas pendentes/enviadas/falhas
audit_log        — trilha imutável de todas as operações (LGPD)
schema_migrations — controle de migrations já aplicadas
```

## Segurança & LGPD

| Controle | Implementação |
|----------|---------------|
| CPF em repouso | AES-256-GCM determinístico em `outbox.aggregate_id` |
| CPF em logs | `safeLog()` / `pino.redact` — nunca aparece completo |
| CPF em audit_log | `safeLog()` aplicado antes do INSERT |
| Auth Ávimus | Bearer token via env var `AVIMUS_API_TOKEN` |
| Auth Tasy | Configurável por adapter (sem auth padrão = rede privada) |

## Escalabilidade

- **Horizontal**: múltiplas instâncias competem por advisory locks no PostgreSQL — apenas uma processa cada ERP por vez
- **Volume**: lotes paralelos de 5 eventos no poller; CLAIM_LIMIT=10 no outbox worker
- **Capacidade esperada**: 11-50 registros/ciclo de 10 minutos
