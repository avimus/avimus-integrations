# Data Model — Multi-route ERP/Avimus Orchestration

## Diagrama de relacionamentos

```
tenants
  └── erp_connections (tenant_id FK)
        └── erp_endpoints (connection_id FK)        ← NOVA TABELA
              ├── field_mappings (endpoint_id FK)   ← MIGRADA
              ├── event_mappings (endpoint_id FK)   ← MIGRADA
              └── sync_state (endpoint_id FK)       ← MIGRADA
outbox (tenant_id FK)
audit_log (tenant_id FK)
```

---

## Tabelas novas e modificadas

### `erp_endpoints` (NOVA)

```sql
CREATE TABLE integrations.erp_endpoints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES integrations.erp_connections(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,           -- ex: '/eventos/start_protocolo'
  credentials   TEXT,                   -- JSON criptografado AES-256 com {"token":"..."}, opcional
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, path)           -- mesma rota não pode ser cadastrada duas vezes na mesma connection
);

CREATE INDEX idx_erp_endpoints_connection ON integrations.erp_endpoints (connection_id) WHERE is_active = true;
```

**Atributos:**
| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `connection_id` | UUID | FK → `erp_connections(id)` |
| `path` | TEXT | Caminho da rota no ERP (ex: `/eventos/start_protocolo`) |
| `credentials` | TEXT | JSON criptografado com token JWT opcional — substitui ou complementa o token da connection |
| `is_active` | BOOLEAN | Controla se o worker processa este endpoint no ciclo de sync |
| `created_at` | TIMESTAMPTZ | Imutável |

---

### `field_mappings` (MIGRADA)

```sql
-- Migration: remover constraint antiga, adicionar endpoint_id
ALTER TABLE integrations.field_mappings
  DROP CONSTRAINT field_mappings_tenant_id_erp_name_source_field_key,
  DROP COLUMN tenant_id,
  DROP COLUMN erp_name,
  ADD COLUMN endpoint_id UUID NOT NULL REFERENCES integrations.erp_endpoints(id) ON DELETE CASCADE,
  ADD CONSTRAINT field_mappings_endpoint_source_uq UNIQUE (endpoint_id, source_field);

CREATE INDEX idx_field_mappings_endpoint ON integrations.field_mappings (endpoint_id);
```

**Schema resultante:**
| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `endpoint_id` | UUID | FK → `erp_endpoints(id)` |
| `source_field` | TEXT | Nome do campo no ERP (ex: `codigo_pessoa_fisica`) |
| `target_field` | TEXT | Nome esperado pelo worker (ex: `cpf`) |
| `transform` | TEXT | Reservado para transformações futuras |
| `created_at` | TIMESTAMPTZ | Imutável |

---

### `event_mappings` (MIGRADA + nova coluna)

```sql
-- Migration: remover constraint antiga, adicionar endpoint_id e avimus_action
ALTER TABLE integrations.event_mappings
  DROP CONSTRAINT event_mappings_tenant_id_erp_name_erp_event_code_key,
  DROP COLUMN tenant_id,
  DROP COLUMN erp_name,
  ADD COLUMN endpoint_id UUID NOT NULL REFERENCES integrations.erp_endpoints(id) ON DELETE CASCADE,
  ADD COLUMN avimus_action TEXT NOT NULL DEFAULT 'complete_step'
    CHECK (avimus_action IN ('complete_step', 'start_journey')),
  ADD CONSTRAINT event_mappings_endpoint_code_uq UNIQUE (endpoint_id, erp_event_code);

CREATE INDEX idx_event_mappings_endpoint ON integrations.event_mappings (endpoint_id);
```

**Schema resultante:**
| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `endpoint_id` | UUID | FK → `erp_endpoints(id)` |
| `erp_event_code` | TEXT | Código do evento no ERP (ex: `CONSULTA_REALIZADA`) |
| `avimus_event_id` | TEXT | `integrationEventId` no Avimus (usado por `complete_step`) |
| `avimus_action` | TEXT | Enum: `complete_step` \| `start_journey` |
| `description` | TEXT | Descrição legível, opcional |
| `created_at` | TIMESTAMPTZ | Imutável |

---

### `sync_state` (MIGRADA)

```sql
-- Migration: substituir (tenant_id, erp_name) por endpoint_id
ALTER TABLE integrations.sync_state
  ADD COLUMN endpoint_id UUID REFERENCES integrations.erp_endpoints(id) ON DELETE CASCADE,
  ADD CONSTRAINT sync_state_endpoint_uq UNIQUE (endpoint_id);

-- após popular endpoint_id nos registros existentes (ou limpar):
ALTER TABLE integrations.sync_state
  DROP COLUMN erp_name;
-- tenant_id pode ser mantido como coluna desnormalizada para queries rápidas de monitoring
```

**Schema resultante:**
| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `endpoint_id` | UUID | FK → `erp_endpoints(id)`, UNIQUE |
| `tenant_id` | UUID | Desnormalizado para queries de monitoring |
| `last_synced_at` | TIMESTAMPTZ | Timestamp da última sincronização bem-sucedida |
| `created_at` | TIMESTAMPTZ | Imutável |
| `updated_at` | TIMESTAMPTZ | Atualizado a cada sync |

---

## Ordem das migrations

```
003_erp_endpoints.sql         -- cria erp_endpoints
004_migrate_mappings.sql      -- reset limpo de field_mappings e event_mappings + adiciona endpoint_id
005_migrate_sync_state.sql    -- adiciona endpoint_id em sync_state, remove erp_name
```

---

## Isolamento multi-tenant — padrão de query

Como `field_mappings` e `event_mappings` não têm mais `tenant_id` direto, toda query da API deve validar o tenant via JOIN:

```sql
SELECT fm.*
FROM field_mappings fm
JOIN erp_endpoints ep ON fm.endpoint_id = ep.id
JOIN erp_connections ec ON ep.connection_id = ec.id
WHERE ec.tenant_id = $1   -- ← isolamento obrigatório
  AND fm.endpoint_id = $2
ORDER BY fm.source_field ASC;
```

---

## Campos obrigatórios por ação Avimus

| Ação | `target_field` obrigatórios em `field_mappings` |
|---|---|
| `complete_step` | `cpf`, `protocolId`, `eventDate`, `erpEventCode` |
| `start_journey` | `cpf`, `protocolId` |

O worker valida a presença desses campos antes de executar a ação. Campos ausentes → registro `falhou` com erro descritivo.
