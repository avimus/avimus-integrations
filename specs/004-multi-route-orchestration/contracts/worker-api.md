# Worker API Contracts — Feature 004

Base URL: `http://localhost:3003`  
Auth: `Authorization: Bearer <WORKER_API_SECRET>` em todos exceto `/health`

---

## Novos endpoints — ERP Endpoints

### Listar endpoints de uma connection

```
GET /tenants/:tenantId/erp-connections/:connId/endpoints
```

Resposta `200`:
```json
[
  {
    "id": "uuid",
    "connection_id": "uuid",
    "path": "/eventos/start_protocolo",
    "is_active": true,
    "created_at": "2026-06-30T00:00:00.000Z"
  }
]
```

---

### Criar endpoint

```
POST /tenants/:tenantId/erp-connections/:connId/endpoints
```

Body:
```json
{
  "path": "/eventos/internacao",
  "credentials": "{\"token\": \"eyJ...\"}",
  "is_active": true
}
```

Resposta `201`: objeto endpoint (sem `credentials`).  
Erro `409`: path duplicado na mesma connection.  
Erro `404`: tenant ou connection não encontrada.

---

### Atualizar endpoint

```
PATCH /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId
```

Body (campos opcionais):
```json
{
  "path": "/eventos/start_protocolo_v2",
  "credentials": "{\"token\": \"eyJ...\"}",
  "is_active": false
}
```

Resposta `200`: objeto endpoint atualizado (sem `credentials`).

---

### Remover endpoint (soft delete)

```
DELETE /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId
```

Resposta `204`. Seta `is_active = false`. Outbox associado permanece intacto.

---

### Introspection — descobrir campos

```
POST /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/introspect
```

Body: vazio `{}`.

O worker chama o endpoint ERP com timeout de 15s e retorna as chaves do primeiro registro.

Resposta `200`:
```json
{
  "endpoint_id": "uuid",
  "path": "/eventos/start_protocolo",
  "fetch_url": "http://localhost:9001/eventos/start_protocolo",
  "fields": [
    "codigo_pessoa_fisica",
    "protocolo",
    "data_atendimento",
    "tipo_atendimento",
    "especialidade",
    "nome_profissional"
  ]
}
```

Erro `504` (timeout/ERP inacessível):
```json
{ "error": "ERP unreachable: connection refused (timeout 15000ms)" }
```

---

## Endpoints migrados — Field Mappings (por endpoint)

### Listar

```
GET /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/field-mappings
```

Resposta `200`:
```json
{
  "endpoint_id": "uuid",
  "mappings": [
    { "id": "uuid", "source_field": "codigo_pessoa_fisica", "target_field": "cpf", "transform": null }
  ]
}
```

---

### Substituir (PUT = replace all)

```
PUT /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/field-mappings
```

Body:
```json
{
  "mappings": [
    { "source_field": "codigo_pessoa_fisica", "target_field": "cpf" },
    { "source_field": "protocolo",            "target_field": "protocolId" },
    { "source_field": "data_atendimento",     "target_field": "eventDate" },
    { "source_field": "tipo_atendimento",     "target_field": "erpEventCode" }
  ]
}
```

Resposta `200`: lista atualizada.

---

## Endpoints migrados — Event Mappings (por endpoint)

### Listar

```
GET /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/event-mappings
```

Resposta `200`:
```json
{
  "endpoint_id": "uuid",
  "mappings": [
    {
      "id": "uuid",
      "erp_event_code": "CONSULTA_REALIZADA",
      "avimus_event_id": "consulta_realizada",
      "avimus_action": "complete_step",
      "description": null
    },
    {
      "id": "uuid",
      "erp_event_code": "INTERNACAO_INICIADA",
      "avimus_event_id": null,
      "avimus_action": "start_journey",
      "description": "Inicia jornada ao ser internado"
    }
  ]
}
```

---

### Substituir

```
PUT /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/event-mappings
```

Body:
```json
{
  "mappings": [
    {
      "erp_event_code": "CONSULTA_REALIZADA",
      "avimus_event_id": "consulta_realizada",
      "avimus_action": "complete_step"
    },
    {
      "erp_event_code": "INTERNACAO_INICIADA",
      "avimus_event_id": null,
      "avimus_action": "start_journey"
    }
  ]
}
```

Validação: `avimus_action` deve ser `complete_step` ou `start_journey`.  
Para `complete_step`: `avimus_event_id` é obrigatório.  
Para `start_journey`: `avimus_event_id` é ignorado (não há step a completar).

---

## Sync Status (atualizado)

```
GET /tenants/:tenantId/sync-status
```

Resposta `200` — contadores agora por endpoint:
```json
{
  "tenant_id": "uuid",
  "connections": [
    {
      "connection_id": "uuid",
      "erp_name": "tasy",
      "base_url": "http://localhost:9001",
      "endpoints": [
        {
          "endpoint_id": "uuid",
          "path": "/eventos/start_protocolo",
          "fetch_url": "http://localhost:9001/eventos/start_protocolo",
          "is_active": true,
          "last_synced_at": "2026-06-30T14:20:00.000Z",
          "next_sync_at": "2026-06-30T14:30:00.000Z",
          "today": {
            "fetched": 47,
            "enqueued": 45,
            "delivered": 45,
            "failed": 0
          }
        },
        {
          "endpoint_id": "uuid",
          "path": "/eventos/internacao",
          "fetch_url": "http://localhost:9001/eventos/internacao",
          "is_active": true,
          "last_synced_at": "2026-06-30T13:50:00.000Z",
          "next_sync_at": "2026-06-30T14:00:00.000Z",
          "today": {
            "fetched": 3,
            "enqueued": 3,
            "delivered": 3,
            "failed": 0
          }
        }
      ]
    }
  ]
}
```

---

## Endpoints removidos (deprecados por esta feature)

| Endpoint antigo | Substituído por |
|---|---|
| `GET /tenants/:id/field-mappings/:erpName` | `GET .../endpoints/:id/field-mappings` |
| `PUT /tenants/:id/field-mappings/:erpName` | `PUT .../endpoints/:id/field-mappings` |
| `GET /tenants/:id/event-mappings/:erpName` | `GET .../endpoints/:id/event-mappings` |
| `PUT /tenants/:id/event-mappings/:erpName` | `PUT .../endpoints/:id/event-mappings` |

Os endpoints antigos são removidos nesta feature — não há período de deprecação pois o admin reconfigura do zero após a migration.
