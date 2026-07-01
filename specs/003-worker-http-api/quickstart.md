# Quickstart: Worker HTTP API (Feature 003)

## Pré-requisitos

- Feature 002 aplicada (migrations rodadas, tabelas existentes no schema `integrations`)
- `WORKER_API_SECRET` definido no `.env` (qualquer string de 32+ chars)
- `WORKER_API_PORT` no `.env` (padrão: 3003)
- `DB_SCHEMA=integrations` no `.env`

## Variáveis de ambiente mínimas (adicionar ao `.env`)

```env
WORKER_API_PORT=3003
WORKER_API_SECRET=dev-secret-change-in-production
DB_SCHEMA=integrations
```

## Subir o worker com a API

```bash
npm run dev
```

Logs esperados na inicialização:
```
{"level":"info","msg":"Starting Ávimus Integrations worker"}
{"level":"info","msg":"Worker HTTP API listening on port 3003"}
{"level":"info","msg":"Multi-tenant sync cycle scheduled"}
{"level":"info","msg":"Outbox delivery scheduled"}
{"level":"info","msg":"Service started successfully"}
```

---

## Validação A — Health check (sem auth)

```bash
curl http://localhost:3003/health
```

Resposta esperada (`200`):
```json
{
  "status": "ok",
  "database": "connected",
  "uptime_seconds": 5
}
```

Sem Bearer token → sem erro (health é público).

---

## Validação B — Autenticação

```bash
# Sem token → 401
curl http://localhost:3003/tenants

# Token errado → 401
curl -H "Authorization: Bearer token-errado" http://localhost:3003/tenants

# Token correto → 200
curl -H "Authorization: Bearer dev-secret-change-in-production" http://localhost:3003/tenants
```

---

## Validação C — Criar tenant e conexão ERP

```bash
TOKEN="dev-secret-change-in-production"
BASE="http://localhost:3003"

# 1. Criar tenant
TENANT=$(curl -sf -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hospital Teste","slug":"hospital-teste"}')
echo $TENANT
TENANT_ID=$(echo $TENANT | jq -r '.id')

# 2. Criar conexão ERP
curl -sf -X POST "$BASE/tenants/$TENANT_ID/erp-connections" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"erp_name\":\"tasy\",\"base_url\":\"http://tasy.interno:9001\",\"timeout_ms\":10000}"

# 3. Listar conexões
curl -sf "$BASE/tenants/$TENANT_ID/erp-connections" \
  -H "Authorization: Bearer $TOKEN"
```

Esperado: `201` nos creates, `200` na listagem com o registro criado.

---

## Validação D — Mapeamentos de campos

```bash
# Salvar field_mappings (PUT substitui integralmente)
curl -sf -X PUT "$BASE/tenants/$TENANT_ID/field-mappings/tasy" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": [
      {"source_field":"codigo_pessoa_fisica","target_field":"cpf"},
      {"source_field":"protocolo","target_field":"protocolId"},
      {"source_field":"data_atendimento","target_field":"eventDate"},
      {"source_field":"tipo_atendimento","target_field":"erpEventCode"}
    ]
  }'

# Verificar
curl -sf "$BASE/tenants/$TENANT_ID/field-mappings/tasy" \
  -H "Authorization: Bearer $TOKEN"

# Substituir com array menor (deve remover os anteriores)
curl -sf -X PUT "$BASE/tenants/$TENANT_ID/field-mappings/tasy" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mappings":[]}'

# Verificar → deve retornar mappings: []
curl -sf "$BASE/tenants/$TENANT_ID/field-mappings/tasy" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Validação E — Mapeamentos de eventos

```bash
curl -sf -X PUT "$BASE/tenants/$TENANT_ID/event-mappings/tasy" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": [
      {"erp_event_code":"CONSULTA_REALIZADA","avimus_event_id":"consulta_realizada"},
      {"erp_event_code":"ALTA_HOSPITALAR","avimus_event_id":"alta_concedida"}
    ]
  }'

curl -sf "$BASE/tenants/$TENANT_ID/event-mappings/tasy" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Validação F — Sync status

```bash
curl -sf "$BASE/tenants/$TENANT_ID/sync-status" \
  -H "Authorization: Bearer $TOKEN"
```

Esperado (`200`):
```json
{
  "tenant_id": "<uuid>",
  "connections": [
    {
      "erp_name": "tasy",
      "last_synced_at": null,
      "next_sync_at": null,
      "today": { "fetched": 0, "enqueued": 0, "delivered": 0, "failed": 0 }
    }
  ]
}
```

---

## Validação G — Outbox listing e retry

```bash
# Listar outbox do tenant (filtrar por status)
curl -sf "$BASE/tenants/$TENANT_ID/outbox?status=falhou&limit=10" \
  -H "Authorization: Bearer $TOKEN"

# Tentar retry em registro falhou (substitua pelo ID real)
OUTBOX_ID="<uuid-de-registro-com-status-falhou>"
curl -sf -X POST "$BASE/tenants/$TENANT_ID/outbox/$OUTBOX_ID/retry" \
  -H "Authorization: Bearer $TOKEN"
# Esperado: 200 { "status": "pendente", "attempt_count": 0 }

# Retry em registro já enviado → deve retornar 409
OUTBOX_ID_ENVIADO="<uuid-de-registro-com-status-enviado>"
curl -sf -X POST "$BASE/tenants/$TENANT_ID/outbox/$OUTBOX_ID_ENVIADO/retry" \
  -H "Authorization: Bearer $TOKEN"
# Esperado: 409 { "error": "Retry only allowed for records with status 'falhou'" }
```

Verificar que `cpf_masked` no response nunca exibe CPF em texto plano.

---

## Validação H — Isolamento de tenant

```bash
# Criar segundo tenant
TENANT2=$(curl -sf -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hospital B","slug":"hospital-b"}')
TENANT2_ID=$(echo $TENANT2 | jq -r '.id')

# Tentar acessar conexões do tenant1 usando tenant2 ID no path
# O endpoint deve retornar [] ou 404, nunca os dados do tenant1
curl -sf "$BASE/tenants/$TENANT2_ID/erp-connections" \
  -H "Authorization: Bearer $TOKEN"
# Esperado: [] (sem dados do tenant1)

# Tentar acessar conexão do tenant1 com ID cruzado
CONNECTION_ID="<id-de-conexao-do-tenant1>"
curl -sf "$BASE/tenants/$TENANT2_ID/erp-connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $TOKEN"
# Esperado: 404 (tenant2 não tem acesso ao dado do tenant1)
```

---

## Validação I — Soft delete de conexão ERP

```bash
# Deletar conexão (soft delete)
curl -sf -X DELETE "$BASE/tenants/$TENANT_ID/erp-connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $TOKEN"
# Esperado: 200 ou 204

# Verificar que ainda aparece na listagem mas is_active = false
curl -sf "$BASE/tenants/$TENANT_ID/erp-connections" \
  -H "Authorization: Bearer $TOKEN"
# is_active deve ser false

# Verificar que o worker não processa conexão inativa
# (observar ausência de log de sync para esse tenant+erp no próximo ciclo)
```

---

## Validação J — slug duplicado

```bash
# Criar tenant com mesmo slug → 409
curl -sf -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hospital Duplicado","slug":"hospital-teste"}'
# Esperado: 409 { "error": "Slug already exists" }
```
