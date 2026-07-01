# Quickstart — Feature 004 (Multi-route Orchestration)

## Pré-requisitos

1. Worker rodando: `npm run dev`
2. Migrations aplicadas: `npm run db:migrate`
3. Variáveis de ambiente: `WORKER_API_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY`

```bash
export BASE="http://localhost:3003"
export TOKEN="$WORKER_API_SECRET"
export TENANT="<uuid-do-tenant>"
export CONN="<uuid-da-erp-connection>"
```

---

## A — Criar endpoint ERP

```bash
curl -s -X POST "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/eventos/start_protocolo",
    "credentials": "{\"token\": \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...\"}"
  }'
# esperado: 201 com objeto endpoint (sem credentials)
```

## B — Descobrir campos do ERP (introspection)

```bash
export ENDPOINT="<uuid-do-endpoint>"

curl -s -X POST "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT/introspect" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
# esperado: 200 com lista de campos
# {
#   "fields": ["codigo_pessoa_fisica", "protocolo", "data_atendimento", ...]
# }
```

## C — Configurar field mappings (usando campos descobertos)

```bash
curl -s -X PUT "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT/field-mappings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": [
      { "source_field": "codigo_pessoa_fisica", "target_field": "cpf" },
      { "source_field": "protocolo",            "target_field": "protocolId" },
      { "source_field": "data_atendimento",     "target_field": "eventDate" },
      { "source_field": "tipo_atendimento",     "target_field": "erpEventCode" }
    ]
  }'
# esperado: 200 com mapeamentos salvos
```

## D — Configurar event mappings com ação complete_step

```bash
curl -s -X PUT "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT/event-mappings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": [
      {
        "erp_event_code": "CONSULTA_REALIZADA",
        "avimus_event_id": "consulta_realizada",
        "avimus_action": "complete_step"
      }
    ]
  }'
# esperado: 200 com mapeamentos salvos
```

## E — Configurar segundo endpoint com ação start_journey

```bash
# Criar segundo endpoint
curl -s -X POST "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "/eventos/internacao"}'

export ENDPOINT2="<uuid-do-segundo-endpoint>"

# Field mappings mínimos para start_journey
curl -s -X PUT "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT2/field-mappings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": [
      { "source_field": "cpf_paciente", "target_field": "cpf" },
      { "source_field": "num_internacao", "target_field": "protocolId" }
    ]
  }'

# Event mapping com ação start_journey
curl -s -X PUT "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT2/event-mappings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mappings": [
      {
        "erp_event_code": "INTERNACAO_INICIADA",
        "avimus_action": "start_journey"
      }
    ]
  }'
```

## F — Verificar sync-status com múltiplos endpoints

```bash
curl -s "$BASE/tenants/$TENANT/sync-status" \
  -H "Authorization: Bearer $TOKEN"
# esperado: cada endpoint com fetch_url e contadores individuais
```

## G — Desativar um endpoint sem afetar o outro

```bash
curl -s -X DELETE "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT2" \
  -H "Authorization: Bearer $TOKEN"
# esperado: 204

# Verificar: sync-status mostra apenas ENDPOINT ativo
curl -s "$BASE/tenants/$TENANT/sync-status" \
  -H "Authorization: Bearer $TOKEN"
```

## H — Endpoint com path duplicado deve retornar 409

```bash
curl -s -X POST "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "/eventos/start_protocolo"}'
# esperado: 409 {"error": "Endpoint path already exists for this connection"}
```

## I — Introspection com ERP inacessível deve retornar 504

```bash
# Assumindo endpoint apontando para URL inválida
curl -s -X POST "$BASE/tenants/$TENANT/erp-connections/$CONN/endpoints/$ENDPOINT/introspect" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
# esperado: 504 {"error": "ERP unreachable: ..."}
```

## J — Isolamento: tenant B não vê endpoints do tenant A

```bash
export TENANT_B="<uuid-tenant-b>"
curl -s "$BASE/tenants/$TENANT_B/erp-connections/$CONN/endpoints" \
  -H "Authorization: Bearer $TOKEN"
# esperado: 404 (connection não pertence ao tenant B)
```
