# Guia Técnico — Ávimus Integrations

**Última atualização**: 2026-06-30  
**Features implementadas**: 002 (Multi-tenant), 003 (Worker HTTP API)  
**Próxima feature planejada**: 004 (Interface Admin no patient-journey/admin)

---

## 1. Visão Geral

`avimus-integrations` é um serviço Node.js/TypeScript que roda como processo de background e sincroniza eventos de ERPs (atualmente Tasy) com a plataforma **Ávimus Patient Journey**. A partir da Feature 003, o mesmo processo também expõe uma API HTTP REST na porta 3003 para que o admin SaaS (porta 3002) possa gerenciar tenants, conexões ERP, mapeamentos e monitorar sincronizações.

### Repositórios do ecossistema

| Projeto | Porta | Descrição |
|---|---|---|
| `patient-journey/web` | 3000 | Frontend do cliente final |
| `patient-journey/api` | 3001 | API principal do Patient Journey |
| `patient-journey/admin` | 3002 | Painel administrativo SaaS |
| `avimus-integrations` | 3003 | Worker + API HTTP (este projeto) |

### Princípios arquiteturais

1. **HTTP-Only Decoupling** — toda comunicação externa via HTTP; sem SDKs proprietários de ERP
2. **ERP-Plugin Architecture** — adicionar novo ERP = novo adapter em `src/adapters/`; zero mudança no core
3. **Simplicity Over Engineering** — sem Redis, sem filas externas, sem ORM
4. **Observability** — logs estruturados pino, CPF sempre mascarado (LGPD)
5. **Data Resilience** — outbox + retry exponencial; nenhum registro perdido silenciosamente
6. **Multi-tenant Isolation** — `tenant_id` obrigatório em todas as queries; cross-tenant é bug crítico
7. **Configuration over Code** — mapeamentos de campos e eventos vivem no banco, não no código
8. **Admin as Consumer** — o admin (3002) acessa o banco somente via Worker API (3003)

---

## 2. Stack Tecnológico

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20+ |
| Linguagem | TypeScript (strict mode, ESM) |
| Banco de dados | PostgreSQL 15+ via Supabase |
| Cliente pg | `pg` (node-postgres) |
| Scheduler | `node-cron` |
| HTTP framework | `fastify` v5 |
| HTTP client | `axios` |
| Logging | `pino` |
| Validação de config | `zod` v4 |
| Criptografia | AES-256-GCM via `node:crypto` (built-in) |
| Dev runner | `tsx` |
| Build | `tsc` |

---

## 3. Arquitetura

```
┌──────────────────────────────────────────────────────────────────────┐
│  avimus-integrations (porta 3003)                                     │
│                                                                       │
│  ┌─────────────────────────┐   ┌────────────────────────────────┐   │
│  │  CRON WORKER             │   │  FASTIFY HTTP API              │   │
│  │                          │   │                                │   │
│  │  a cada N min:           │   │  GET  /health                  │   │
│  │  → multiTenantSyncCycle  │   │  GET  /tenants                 │   │
│  │    por cada tenant ativo │   │  POST /tenants                 │   │
│  │    → fetchRecentEvents   │   │  PATCH /tenants/:id            │   │
│  │    → transformEvent      │   │  GET/POST/PATCH/DELETE         │   │
│  │    → enqueue (outbox)    │   │    /tenants/:id/erp-connections│   │
│  │                          │   │  GET/PUT                       │   │
│  │  a cada 1 min:           │   │    /tenants/:id/field-mappings │   │
│  │  → processPendingDeliveries   │  GET/PUT                      │   │
│  │    → completeStep (PATCH)│   │    /tenants/:id/event-mappings │   │
│  │    → markSent/markFailed │   │  GET /tenants/:id/sync-status  │   │
│  └─────────────────────────┘   │  GET /tenants/:id/outbox       │   │
│           │                    │  POST .../outbox/:id/retry      │   │
│           │                    └────────────────────────────────┘   │
│           │         shared Pool (pg)                                 │
│           └─────────────────────────┐                               │
│                                     ▼                               │
│                           PostgreSQL (Supabase)                     │
│                           schema: integrations                      │
└──────────────────────────────────────────────────────────────────────┘
         │                                      ▲
         │ GET /atendimentos/recentes            │
         ▼                                      │ PATCH /steps/:id/complete
    Tasy ERP                            Ávimus API (3001)
```

### Fluxo do cron worker (por tenant)

```
multiTenantSyncCycle
  └── para cada tenant ativo:
        └── para cada erp_connection ativa do tenant:
              1. fetchRecentEvents(since: last_synced_at)
              2. para cada evento:
                   a. transformEvent() → busca field_mappings e event_mappings do banco
                   b. matchPatient/Journey/Step via Ávimus API
                   c. enqueue() → INSERT outbox (aggregate_id = encrypt(CPF))
              3. UPDATE sync_state.last_synced_at

processPendingDeliveries (a cada minuto)
  └── claimPending() → registros pendente
        └── para cada registro:
              1. decrypt(aggregate_id) → CPF plaintext
              2. hasRecentSuccess() → idempotência (filtra por tenant_id)
              3. completeStep() → PATCH Ávimus API
              4. markSent() ou markFailed() com retry exponencial
```

---

## 4. Banco de Dados

**Schema**: `integrations` (Supabase — separado do schema `public` do patient-journey)

### Tabelas

```sql
-- Controle de polling por tenant+ERP
sync_state (
  id           UUID PK,
  tenant_id    UUID FK → tenants(id),
  erp_name     TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ
)

-- Fila de entregas (outbox pattern)
outbox (
  id             UUID PK,
  tenant_id      UUID FK → tenants(id),
  aggregate_type TEXT DEFAULT 'patient_journey',
  aggregate_id   TEXT,           -- CPF criptografado AES-256-GCM
  event_type     TEXT,
  payload        JSONB,
  status         ENUM(pendente, enviado, falhou),
  attempt_count  INT,
  max_attempts   INT DEFAULT 3,
  last_error     TEXT,
  correlation_id UUID,
  erp_name       TEXT,
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ
)

-- Trilha de auditoria imutável
audit_log (
  id             BIGSERIAL PK,
  tenant_id      UUID FK → tenants(id),
  timestamp      TIMESTAMPTZ,
  action         TEXT,           -- ex: 'sync_cycle.complete', 'delivery.success'
  component      TEXT,
  record_type    TEXT,
  record_id      TEXT,
  erp_name       TEXT,
  details        JSONB,
  correlation_id UUID
)

-- Clientes/hospitais
tenants (
  id         UUID PK,
  name       TEXT,
  slug       TEXT UNIQUE,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ
)

-- Configuração de ERP por tenant
erp_connections (
  id          UUID PK,
  tenant_id   UUID FK → tenants(id),
  erp_name    TEXT,              -- ex: 'tasy'
  base_url    TEXT,
  timeout_ms  INT DEFAULT 10000,
  credentials TEXT,              -- JSON criptografado AES-256; null = sem auth
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ
)

-- De-para de campos ERP → Ávimus por tenant
field_mappings (
  id           UUID PK,
  tenant_id    UUID FK → tenants(id),
  erp_name     TEXT,
  source_field TEXT,             -- nome do campo no ERP
  target_field TEXT,             -- nome esperado pelo worker
  transform    TEXT,             -- reservado; não avaliado na v atual
  created_at   TIMESTAMPTZ,
  UNIQUE (tenant_id, erp_name, source_field)
)

-- De-para de eventos ERP → Ávimus por tenant
event_mappings (
  id              UUID PK,
  tenant_id       UUID FK → tenants(id),
  erp_name        TEXT,
  erp_event_code  TEXT,          -- código no ERP (ex: 'CONSULTA_REALIZADA')
  avimus_event_id TEXT,          -- integrationEventId do Ávimus
  description     TEXT,
  created_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, erp_name, erp_event_code)
)
```

### Migrations

As migrations ficam em `src/db/migrations/` e são aplicadas pelo script `src/db/migrate.ts`:

| Migration | Descrição |
|---|---|
| `001_initial.sql` | Tabelas base: `sync_state`, `outbox`, `audit_log` |
| `002_multi_tenant.sql` | Tabelas `tenants`, `erp_connections`, `field_mappings`, `event_mappings`; `tenant_id` em `outbox`, `sync_state`, `audit_log` |

---

## 5. Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha os valores reais.

```env
# ── Banco de dados ────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@host:5432/database
# Supabase: use a connection string do pooler (port 5432)
# Exemplo: postgresql://postgres.project:senha@aws-1-sa-east-1.pooler.supabase.com:5432/postgres

DB_POOL_MAX=10          # conexões máximas no pool (padrão: 10)
DB_SCHEMA=integrations  # schema PostgreSQL (padrão: integrations)

# ── Ávimus Patient Journey API ────────────────────────────────────────
AVIMUS_API_URL=https://api.avimus.com   # URL base da API (sem trailing slash)
AVIMUS_API_TOKEN=seu-bearer-token       # Bearer token da API do Ávimus

# ── Criptografia (LGPD) ───────────────────────────────────────────────
# Gerar: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=64-caracteres-hexadecimais-aqui

# ── Worker HTTP API ───────────────────────────────────────────────────
WORKER_API_PORT=3003                         # porta da API (padrão: 3003)
WORKER_API_SECRET=string-secreta-32-chars+   # Bearer token compartilhado com admin

# ── Serviço ───────────────────────────────────────────────────────────
NODE_ENV=development                  # development | staging | production
LOG_LEVEL=info                        # debug | info | warn | error
INITIAL_LOOKBACK_HOURS=24             # janela de busca no primeiro ciclo (padrão: 24)
MAX_RETRIES=3                         # tentativas máximas de entrega (padrão: 3)
POLLING_INTERVAL_MINUTES=10           # intervalo do cron de sincronização (padrão: 10)
```

### Gerar ENCRYPTION_KEY

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Gerar WORKER_API_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## 6. Instalação

```bash
# 1. Instalar dependências
npm install

# 2. Copiar e preencher variáveis de ambiente
cp .env.example .env
# editar .env com os valores reais

# 3. Aplicar migrations no banco
npm run db:migrate

# 4. Opcional: popular dados iniciais (ver seção 9)
```

---

## 7. Como Iniciar o Serviço

### Desenvolvimento (com hot-reload via tsx)

```bash
npm run dev
```

**Logs esperados na inicialização:**

```
{"level":"info","msg":"Starting Ávimus Integrations worker","env":"development"}
{"level":"info","msg":"Worker HTTP API listening","port":3003}
{"level":"info","msg":"Multi-tenant sync cycle scheduled","schedule":"*/10 * * * *"}
{"level":"info","msg":"Outbox delivery scheduled"}
{"level":"info","msg":"Service started successfully"}
```

### Produção (build TypeScript)

```bash
npm run build       # compila para dist/
npm run start       # node dist/index.js
```

### Typecheck (sem emitir arquivos)

```bash
npm run typecheck
```

### Shutdown gracioso

O serviço responde a `SIGTERM` e `SIGINT`. Ao receber o sinal:
1. Para os cron jobs
2. Aborta requisições HTTP em andamento
3. Fecha o servidor Fastify
4. Fecha o pool PostgreSQL
5. Exit 0

---

## 8. Referência da API HTTP

**Base URL**: `http://localhost:3003`  
**Autenticação**: `Authorization: Bearer <WORKER_API_SECRET>` em todos os endpoints exceto `/health`  
**Content-Type**: `application/json`

### Health Check (público)

```
GET /health
```

Resposta `200`:
```json
{ "status": "ok", "database": "connected", "uptime_seconds": 42 }
```

Resposta `503` (banco inacessível):
```json
{ "status": "degraded", "database": "disconnected", "error": "..." }
```

---

### Tenants

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/tenants` | Lista todos os tenants (ativos e inativos) |
| `POST` | `/tenants` | Cria novo tenant |
| `GET` | `/tenants/:id` | Busca tenant por UUID |
| `PATCH` | `/tenants/:id` | Atualiza nome ou status |

**POST /tenants** — body:
```json
{ "name": "Hospital A", "slug": "hospital-a" }
```

**PATCH /tenants/:id** — body (campos opcionais):
```json
{ "name": "Hospital A Atualizado", "is_active": false }
```

**Resposta** (tenant):
```json
{
  "id": "uuid",
  "name": "Hospital A",
  "slug": "hospital-a",
  "is_active": true,
  "created_at": "2026-06-30T00:00:00.000Z"
}
```

Erros: `409` slug duplicado, `404` não encontrado.

---

### ERP Connections

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/tenants/:tenantId/erp-connections` | Lista conexões do tenant (ativas e inativas) |
| `POST` | `/tenants/:tenantId/erp-connections` | Adiciona conexão ERP |
| `PATCH` | `/tenants/:tenantId/erp-connections/:id` | Atualiza conexão |
| `DELETE` | `/tenants/:tenantId/erp-connections/:id` | Desativa conexão (soft delete) |

**POST body**:
```json
{
  "erp_name": "tasy",
  "base_url": "http://192.168.80.190:9001",
  "timeout_ms": 10000,
  "credentials": "{ \"user\": \"api\", \"password\": \"senha\" }"
}
```

> ⚠️ `credentials` é criptografado antes do INSERT. **Nunca retornado** nas respostas.

**Resposta** (connection — sem campo `credentials`):
```json
{
  "id": "uuid",
  "tenant_id": "uuid",
  "erp_name": "tasy",
  "base_url": "http://192.168.80.190:9001",
  "timeout_ms": 10000,
  "is_active": true,
  "created_at": "2026-06-30T00:00:00.000Z"
}
```

Erros: `404` tenant/conexão não encontrado, `204` em DELETE bem-sucedido.

---

### Field Mappings (De-Para de Campos)

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/tenants/:tenantId/field-mappings/:erpName` | Lista mapeamentos do tenant+ERP |
| `PUT` | `/tenants/:tenantId/field-mappings/:erpName` | Substitui integralmente todos os mapeamentos |

**PUT body** (`mappings` pode ser array vazio para limpar):
```json
{
  "mappings": [
    { "source_field": "codigo_pessoa_fisica", "target_field": "cpf" },
    { "source_field": "protocolo", "target_field": "protocolId" },
    { "source_field": "data_atendimento", "target_field": "eventDate" },
    { "source_field": "tipo_atendimento", "target_field": "erpEventCode" }
  ]
}
```

**Campos obrigatórios para o worker funcionar**: `cpf`, `protocolId`, `eventDate`, `erpEventCode`.

**Resposta**:
```json
{
  "erp_name": "tasy",
  "mappings": [
    { "id": "uuid", "source_field": "codigo_pessoa_fisica", "target_field": "cpf", "transform": null }
  ]
}
```

---

### Event Mappings (De-Para de Eventos)

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/tenants/:tenantId/event-mappings/:erpName` | Lista mapeamentos de eventos |
| `PUT` | `/tenants/:tenantId/event-mappings/:erpName` | Substitui integralmente |

**PUT body**:
```json
{
  "mappings": [
    { "erp_event_code": "CONSULTA_REALIZADA", "avimus_event_id": "consulta_realizada" },
    { "erp_event_code": "ALTA_HOSPITALAR",    "avimus_event_id": "alta_concedida" }
  ]
}
```

---

### Sync Status

```
GET /tenants/:tenantId/sync-status
```

**Resposta**:
```json
{
  "tenant_id": "uuid",
  "connections": [
    {
      "erp_name": "tasy",
      "last_synced_at": "2026-06-30T14:20:00.000Z",
      "next_sync_at":   "2026-06-30T14:30:00.000Z",
      "today": {
        "fetched":   47,
        "enqueued":  45,
        "delivered": 45,
        "failed":     0
      }
    }
  ]
}
```

Contadores referem-se ao dia corrente em UTC. `next_sync_at` é calculado em runtime (`last_synced_at + POLLING_INTERVAL_MINUTES`).

---

### Outbox

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/tenants/:tenantId/outbox` | Lista registros com filtros e paginação |
| `POST` | `/tenants/:tenantId/outbox/:id/retry` | Reprocessa registro com status `falhou` |

**Query params do GET**:

| Param | Tipo | Descrição |
|---|---|---|
| `status` | `pendente\|enviado\|falhou` | Filtro de status |
| `date` | ISO date `2026-06-30` | Filtra `created_at >= date` |
| `limit` | int 1–100 | Itens por página (padrão: 20) |
| `cursor` | string opaco | Cursor da página anterior |

**Resposta do GET**:
```json
{
  "records": [
    {
      "id": "uuid",
      "tenant_id": "uuid",
      "status": "falhou",
      "event_type": "step_completed",
      "cpf_masked": "***.456.789-**",
      "attempt_count": 3,
      "last_error": "503 Service Unavailable",
      "created_at": "2026-06-30T14:00:00.000Z"
    }
  ],
  "next_cursor": "eyJ0IjoiMjAyNi0wNi0zMFQxNDowMDowMC4wMDBaIiwi..."
}
```

> ⚠️ `cpf_masked` mostra apenas os grupos centrais (`***.XXX.YYY-**`). CPF nunca aparece completo nas respostas.

**POST retry** — resposta `200`:
```json
{ "id": "uuid", "status": "pendente", "attempt_count": 0 }
```

Erro `409` se o registro não estiver com `status = 'falhou'`.

---

## 9. Testar em Localhost

### Pré-requisitos

1. `.env` preenchido (seção 5)
2. Migrations aplicadas (`npm run db:migrate`)
3. Worker rodando (`npm run dev`)
4. Banco com pelo menos um tenant e uma erp_connection

### Seed inicial (dados mínimos)

```bash
# Cria tenants e dados de exemplo via seed temporário
# Copie o conteúdo abaixo em seed-temp.ts na raiz, rode, depois apague

npx tsx seed-temp.ts
```

Ou insira manualmente via SQL:

```sql
SET search_path TO integrations;

INSERT INTO tenants (name, slug) VALUES
  ('Hospital A', 'hospital-a'),
  ('Hospital B', 'hospital-b');

-- substitua <UUID-A> pelo id retornado acima
INSERT INTO erp_connections (tenant_id, erp_name, base_url, is_active)
VALUES ('<UUID-A>', 'tasy', 'http://tasy.interno:9001', true);

INSERT INTO field_mappings (tenant_id, erp_name, source_field, target_field) VALUES
  ('<UUID-A>', 'tasy', 'codigo_pessoa_fisica', 'cpf'),
  ('<UUID-A>', 'tasy', 'protocolo',            'protocolId'),
  ('<UUID-A>', 'tasy', 'data_atendimento',      'eventDate'),
  ('<UUID-A>', 'tasy', 'tipo_atendimento',      'erpEventCode');

INSERT INTO event_mappings (tenant_id, erp_name, erp_event_code, avimus_event_id)
VALUES ('<UUID-A>', 'tasy', 'CONSULTA_REALIZADA', 'consulta_realizada');
```

### Sequência de validação (quickstart)

```bash
export TOKEN="seu-WORKER_API_SECRET"
export BASE="http://localhost:3003"
export TENANT="uuid-do-tenant-criado"

# A — Health (sem token)
curl $BASE/health

# B — Auth: sem token deve dar 401, com token deve dar 200
curl $BASE/tenants
curl -H "Authorization: Bearer $TOKEN" $BASE/tenants

# C — Criar tenant e listar conexões
curl -s -X POST $BASE/tenants \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hospital Teste","slug":"hospital-teste"}'

curl -s $BASE/tenants/$TENANT/erp-connections \
  -H "Authorization: Bearer $TOKEN"

# D — Field mappings (PUT substitui tudo; array vazio limpa)
curl -s -X PUT $BASE/tenants/$TENANT/field-mappings/tasy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mappings":[{"source_field":"codigo_pessoa_fisica","target_field":"cpf"}]}'

curl -s $BASE/tenants/$TENANT/field-mappings/tasy \
  -H "Authorization: Bearer $TOKEN"

# E — Event mappings
curl -s -X PUT $BASE/tenants/$TENANT/event-mappings/tasy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mappings":[{"erp_event_code":"CONSULTA","avimus_event_id":"consulta_realizada"}]}'

# F — Sync status (contadores do dia)
curl -s $BASE/tenants/$TENANT/sync-status \
  -H "Authorization: Bearer $TOKEN"

# G — Outbox listing e retry
curl -s "$BASE/tenants/$TENANT/outbox?status=falhou&limit=10" \
  -H "Authorization: Bearer $TOKEN"

# retry (substitua <OUTBOX-ID> por UUID real com status falhou)
curl -s -X POST $BASE/tenants/$TENANT/outbox/<OUTBOX-ID>/retry \
  -H "Authorization: Bearer $TOKEN"

# H — Isolamento: Hospital B não vê dados do Hospital A
export TENANT_B="uuid-hospital-b"
curl -s $BASE/tenants/$TENANT_B/erp-connections \
  -H "Authorization: Bearer $TOKEN"
# deve retornar [] — sem dados do Hospital A

# I — Soft delete (is_active=false, outbox intacto)
curl -s -X DELETE $BASE/tenants/$TENANT/erp-connections/<CONN-ID> \
  -H "Authorization: Bearer $TOKEN"
curl -s $BASE/tenants/$TENANT/erp-connections \
  -H "Authorization: Bearer $TOKEN"
# is_active deve ser false no retorno

# J — Slug duplicado → 409
curl -s -X POST $BASE/tenants \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Dup","slug":"hospital-teste"}'
# deve retornar 409 {"error":"Slug already exists"}
```

---

## 10. Segurança

| Controle | Implementação | Arquivo |
|---|---|---|
| Autenticação da API | Bearer token via `WORKER_API_SECRET`; comparação `timingSafeEqual` | `src/api/auth.ts` |
| CPF em repouso | AES-256-GCM determinístico (IV = HMAC-SHA256(key, plaintext)) | `src/lib/crypto.ts` |
| CPF em logs | `maskCpf()` → `***.XXX.YYY-**`; `pino.redact` automático | `src/lib/mask.ts` |
| CPF nas respostas da API | `listOutbox` descriptografa e mascara antes de retornar | `src/db/queries/outbox.ts` |
| Credentials ERP | Criptografadas antes do INSERT; `toPublic()` as remove antes de retornar | `src/db/queries/erp-connections.ts` |
| Isolamento multi-tenant | `tenant_id` como primeiro filtro em toda query da API | todos em `src/api/routes/` |
| CORS | Não configurado — a API é server-to-server (admin 3002 → worker 3003) | — |
| `WORKER_API_SECRET` | Nunca exposto ao browser; apenas entre backends | `src/api/auth.ts` |

### Notas sobre a chave de criptografia

- `ENCRYPTION_KEY` deve ser uma string hexadecimal de 64 caracteres (256 bits)
- A criptografia é **determinística**: o mesmo CPF sempre produz o mesmo ciphertext, permitindo queries de igualdade no banco
- **Consequência**: em caso de comprometimento da chave, todos os CPFs no banco ficam expostos — rotacionar a chave exige re-criptografar todos os registros

---

## 11. Estrutura de Arquivos

```
src/
├── index.ts                          # entry point — inicia cron + API HTTP
├── config/
│   └── index.ts                      # Zod schema + loadConfig() + getConfig()
├── api/
│   ├── auth.ts                       # buildAuthHook() com timingSafeEqual
│   ├── server.ts                     # buildApiServer(pool, config)
│   └── routes/
│       ├── health.ts                 # GET /health
│       ├── tenants.ts                # GET/POST/PATCH /tenants
│       ├── erp-connections.ts        # CRUD /tenants/:id/erp-connections
│       ├── field-mappings.ts         # GET/PUT /tenants/:id/field-mappings/:erp
│       ├── event-mappings.ts         # GET/PUT /tenants/:id/event-mappings/:erp
│       ├── sync-status.ts            # GET /tenants/:id/sync-status
│       └── outbox.ts                 # GET /tenants/:id/outbox + POST retry
├── db/
│   ├── index.ts                      # singleton Pool + search_path hook
│   ├── migrate.ts                    # runner de migrations (pg.Client)
│   ├── migrations/
│   │   ├── 001_initial.sql
│   │   └── 002_multi_tenant.sql
│   └── queries/
│       ├── tenants.ts
│       ├── erp-connections.ts
│       ├── field-mappings.ts
│       ├── event-mappings.ts
│       ├── outbox.ts                 # enqueue, claimPending, listOutbox, retry
│       └── sync-status.ts
├── services/
│   ├── tenant-orchestrator.ts        # loop multi-tenant do cron
│   ├── outbox-worker.ts              # delivery loop
│   ├── poller.ts                     # fetch + transform + enqueue por tenant
│   ├── transformer.ts
│   └── matcher.ts
├── adapters/
│   └── tasy/                         # adapter do ERP Tasy
├── lib/
│   ├── crypto.ts                     # encrypt/decrypt AES-256-GCM
│   ├── mask.ts                       # maskCpf()
│   ├── logger.ts                     # pino configurado + safeLog()
│   ├── mutex.ts                      # pg_try_advisory_lock
│   └── backoff.ts                    # retry com jitter exponencial
specs/
├── evolution-briefing.md             # contexto estratégico das features
├── 002-worker-multi-tenant/          # spec completa da Feature 002
└── 003-worker-http-api/              # spec completa da Feature 003
docs/
├── technical-guide.md                # este arquivo
├── architecture.md                   # arquitetura original (pré-Feature 002)
├── operations.md
├── security.md
├── api-contracts.md
└── adr/                              # Architecture Decision Records
    ├── 001-outbox-pattern.md
    ├── 002-deterministic-encryption.md
    └── 003-single-retry-mechanism.md
```

---

## 12. Adicionar Novo ERP

Ver `ADDING_ERPS.md` na raiz do projeto. Resumo:

1. Criar `src/adapters/{nome}/index.ts` implementando `ErpAdapter`
2. Registrar em `src/adapters/erp-registry.ts`
3. Criar `erp_connection` no banco para o tenant via API: `POST /tenants/:id/erp-connections`
4. Configurar `field_mappings` e `event_mappings` via API: `PUT /tenants/:id/field-mappings/{nome}`
5. Zero mudanças no core do worker

---

## 13. Próxima Feature (004)

**Interface de Integrações no Admin** (`patient-journey/admin`, porta 3002):

- Nova rota `/integrations` no admin — consome a Worker API (3003) server-side
- Gerenciar ERPs por tenant com toggle ativo/inativo
- Mapeamento de campos com interface drag-and-drop (`@dnd-kit`)
- Mapeamento de eventos via tabela editável
- Dashboard de monitoramento (sync status + contadores do dia)
- Lista de falhas com botão de retry manual

**Dependência**: Feature 003 concluída ✅ → Feature 004 pode iniciar.
