# Data Model: Worker HTTP API (Feature 003)

Feature 003 não cria novas tabelas. Todas as operações de leitura e escrita usam as tabelas criadas pela Feature 002. Esta seção documenta as **interfaces TypeScript de request/response** e as **novas funções de query** necessárias para os endpoints.

---

## Novas Variáveis de Ambiente

| Variável | Tipo | Padrão | Descrição |
|---|---|---|---|
| `WORKER_API_PORT` | `number` | `3003` | Porta em que o servidor HTTP sobe |
| `WORKER_API_SECRET` | `string` | — (obrigatório) | Bearer token compartilhado entre worker e admin |
| `DB_SCHEMA` | `string` | `integrations` | Schema PostgreSQL para search_path |

---

## Novos Módulos de Query

### `src/db/queries/tenants.ts` — funções adicionadas

```typescript
export interface CreateTenantInput {
  name: string;
  slug: string;
}
export async function createTenant(pool: Pool, input: CreateTenantInput): Promise<Tenant>

export interface UpdateTenantInput {
  name?: string;
  is_active?: boolean;
}
export async function updateTenant(pool: Pool, id: string, input: UpdateTenantInput): Promise<Tenant | null>

// já existe:
export async function getActiveTenants(pool: Pool): Promise<Tenant[]>
// nova — lista todos (inclusive inativos) para a API:
export async function getAllTenants(pool: Pool): Promise<Tenant[]>
export async function getTenantById(pool: Pool, id: string): Promise<Tenant | null>
```

### `src/db/queries/erp-connections.ts` — funções adicionadas

```typescript
export interface CreateConnectionInput {
  tenant_id: string;
  erp_name: string;
  base_url: string;
  timeout_ms?: number;
  credentials?: string; // plaintext — criptografado antes do INSERT
}
export async function createConnection(pool: Pool, input: CreateConnectionInput): Promise<ErpConnection>

export interface UpdateConnectionInput {
  base_url?: string;
  timeout_ms?: number;
  credentials?: string;
  is_active?: boolean;
}
export async function updateConnection(pool: Pool, tenantId: string, id: string, input: UpdateConnectionInput): Promise<ErpConnection | null>

// soft delete — seta is_active = false
export async function softDeleteConnection(pool: Pool, tenantId: string, id: string): Promise<boolean>

// lista todas (ativas e inativas) para a API
export async function getAllConnections(pool: Pool, tenantId: string): Promise<ErpConnection[]>
```

### `src/db/queries/field-mappings.ts` — funções adicionadas

```typescript
export interface FieldMappingInput {
  source_field: string;
  target_field: string;
  transform?: string | null;
}
// substitui integralmente todos os mapeamentos do par (tenant_id, erp_name) em transação
export async function replaceFieldMappings(
  pool: Pool,
  tenantId: string,
  erpName: string,
  mappings: FieldMappingInput[],
): Promise<FieldMapping[]>
```

### `src/db/queries/event-mappings.ts` — funções adicionadas

```typescript
export interface EventMappingInput {
  erp_event_code: string;
  avimus_event_id: string;
  description?: string | null;
}
// substitui integralmente todos os mapeamentos do par (tenant_id, erp_name) em transação
export async function replaceEventMappings(
  pool: Pool,
  tenantId: string,
  erpName: string,
  mappings: EventMappingInput[],
): Promise<EventMapping[]>
```

### `src/db/queries/outbox.ts` — funções adicionadas

```typescript
export interface ListOutboxInput {
  tenantId: string;
  status?: 'pendente' | 'enviado' | 'falhou';
  date?: string;       // ISO date string — filtra created_at >= date (UTC)
  limit: number;       // máximo 100
  cursor?: string;     // cursor opaco base64url
}

export interface OutboxPage {
  records: OutboxRecord[];
  next_cursor: string | null;
}

export async function listOutbox(pool: Pool, input: ListOutboxInput): Promise<OutboxPage>

// volta o registro para 'pendente', zera attempt_count e preserva last_error
// retorna false se status não for 'falhou'
export async function retryOutboxRecord(pool: Pool, tenantId: string, id: string): Promise<boolean>
```

### `src/db/queries/sync-status.ts` — novo módulo

```typescript
export interface ErpSyncStatus {
  erp_name: string;
  last_synced_at: Date | null;
  next_sync_at: Date | null;      // calculado em TypeScript: last_synced_at + POLLING_INTERVAL_MINUTES
  fetched_today: number;
  enqueued_today: number;
  delivered_today: number;
  failed_today: number;
}

export async function getSyncStatus(
  pool: Pool,
  tenantId: string,
  pollingIntervalMinutes: number,
): Promise<ErpSyncStatus[]>
```

---

## Interfaces de Request/Response da API

### Tenants

**`POST /tenants`** body:
```typescript
{ name: string; slug: string }
```
**`PATCH /tenants/:id`** body:
```typescript
{ name?: string; is_active?: boolean }
```
**Resposta** (tenant):
```typescript
{ id: string; name: string; slug: string; is_active: boolean; created_at: string }
```

### ERP Connections

**`POST .../erp-connections`** body:
```typescript
{ erp_name: string; base_url: string; timeout_ms?: number; credentials?: string }
```
**`PATCH .../erp-connections/:id`** body:
```typescript
{ base_url?: string; timeout_ms?: number; credentials?: string; is_active?: boolean }
```
**Resposta** (connection — `credentials` nunca incluído):
```typescript
{ id: string; tenant_id: string; erp_name: string; base_url: string; timeout_ms: number; is_active: boolean; created_at: string }
```

### Field Mappings

**`PUT .../field-mappings/:erpName`** body:
```typescript
{ mappings: Array<{ source_field: string; target_field: string; transform?: string }> }
```
**Resposta**:
```typescript
{ erp_name: string; mappings: Array<{ id: string; source_field: string; target_field: string; transform: string | null }> }
```

### Event Mappings

**`PUT .../event-mappings/:erpName`** body:
```typescript
{ mappings: Array<{ erp_event_code: string; avimus_event_id: string; description?: string }> }
```
**Resposta**:
```typescript
{ erp_name: string; mappings: Array<{ id: string; erp_event_code: string; avimus_event_id: string; description: string | null }> }
```

### Outbox

**`GET .../outbox`** query params: `status`, `date` (ISO), `limit` (int, max 100), `cursor` (base64url)

**Resposta** (record — `aggregate_id` mascarado):
```typescript
{
  records: Array<{
    id: string;
    tenant_id: string;
    status: 'pendente' | 'enviado' | 'falhou';
    event_type: string;
    cpf_masked: string;  // ex: "***.456.789-**"
    attempt_count: number;
    last_error: string | null;
    created_at: string;
  }>;
  next_cursor: string | null;
}
```

### Sync Status

**`GET .../sync-status`** resposta:
```typescript
{
  tenant_id: string;
  connections: Array<{
    erp_name: string;
    last_synced_at: string | null;
    next_sync_at: string | null;
    today: {
      fetched: number;
      enqueued: number;
      delivered: number;
      failed: number;
    };
  }>;
}
```

### Health

**`GET /health`** resposta:
```typescript
// 200:
{ status: 'ok'; database: 'connected'; uptime_seconds: number }
// 503:
{ status: 'degraded'; database: 'disconnected'; error?: string }
```

---

## Estrutura de Arquivos Novos/Modificados

```text
src/
├── api/
│   ├── server.ts                    ← NEW: buildApiServer(pool, config): FastifyInstance
│   ├── auth.ts                      ← NEW: onRequest hook Bearer token
│   └── routes/
│       ├── health.ts                ← NEW: GET /health
│       ├── tenants.ts               ← NEW: GET/POST/PATCH /tenants
│       ├── erp-connections.ts       ← NEW: GET/POST/PATCH/DELETE /tenants/:id/erp-connections
│       ├── field-mappings.ts        ← NEW: GET/PUT /tenants/:id/field-mappings/:erpName
│       ├── event-mappings.ts        ← NEW: GET/PUT /tenants/:id/event-mappings/:erpName
│       ├── sync-status.ts           ← NEW: GET /tenants/:id/sync-status
│       └── outbox.ts                ← NEW: GET /tenants/:id/outbox + POST .../retry
├── db/
│   └── queries/
│       ├── tenants.ts               ← MODIFIED: + createTenant, updateTenant, getAllTenants, getTenantById
│       ├── erp-connections.ts       ← MODIFIED: + createConnection, updateConnection, softDeleteConnection, getAllConnections
│       ├── field-mappings.ts        ← MODIFIED: + replaceFieldMappings
│       ├── event-mappings.ts        ← MODIFIED: + replaceEventMappings
│       ├── outbox.ts                ← MODIFIED: + listOutbox, retryOutboxRecord
│       └── sync-status.ts           ← NEW: getSyncStatus
├── lib/
│   └── mask.ts                      ← NEW: maskCpf extraído de logger.ts
├── config/
│   └── index.ts                     ← MODIFIED: + workerApiPort, workerApiSecret, dbSchema
├── db/
│   └── index.ts                     ← MODIFIED: + search_path via pool.on('connect')
└── index.ts                         ← MODIFIED: inicia Fastify ao lado do cron
```
