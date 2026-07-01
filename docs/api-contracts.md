# Contratos de API

Documentação dos contratos HTTP consumidos pelo serviço. Ver também os arquivos detalhados em `specs/001-tasy-avimus-sync/contracts/`.

## Tasy ERP

**Base URL**: `TASY_BASE_URL` (ex: `http://192.168.80.190:9001`)  
**Auth**: Configurável por adapter (padrão: rede privada)

### GET /atendimentos/recentes

Retorna atendimentos desde um timestamp.

**Query params**:
- `since` (ISO 8601) — apenas registros após esta data

**Response 200**:
```json
[
  {
    "protocolo": "12345",
    "cpf": "12345678901",
    "evento_codigo": "CONSULTA_REALIZADA",
    "data_atendimento": "2026-06-29T10:00:00Z",
    "tipo_atendimento": "consulta",
    "especialidade": "cardiologia",
    "nome_profissional": "Dr. Silva"
  }
]
```

**Erros**:
| Status | `transient` | Comportamento |
|--------|-------------|---------------|
| 401 | false | Falha permanente — verificar auth |
| 404 | false | Endpoint não encontrado |
| 500 | true | Retry no próximo ciclo |
| 503 | true | Retry no próximo ciclo |
| Network | true | Retry no próximo ciclo |

---

## Ávimus Patient Journey API

**Base URL**: `AVIMUS_API_URL`  
**Auth**: `Authorization: Bearer {AVIMUS_API_TOKEN}`

### GET /api/v1/patients?cpf={cpf}

Busca paciente por CPF.

**Response 200**: `{ "id": "uuid", "cpf": "...", "name": "..." }`  
**Response 404**: Paciente não encontrado → log + skip (não enfileirar)

### GET /api/v1/journeys?patientId={id}&status=ativo

Lista jornadas ativas do paciente.

**Response 200**: Array de jornadas (filtra `status=ativo` server-side)  
**Response 404**: Sem jornadas ativas → log + skip

### GET /api/v1/journeys/{journeyId}/steps

Lista steps de uma jornada.

**Matching**: `step.integrationEventId === erpEventCode`

### PATCH /api/v1/steps/{stepId}/complete

Conclui um step.

**Body**:
```json
{
  "result": "completed",
  "notes": "Sincronizado automaticamente via integração ERP",
  "metadata": {
    "erpName": "tasy",
    "protocolId": "PROTO-001",
    "eventDate": "2026-06-29T10:00:00Z"
  }
}
```

**Erros e comportamento do outbox-worker**:
| Status | Comportamento |
|--------|---------------|
| 200 | `markSent()` |
| 404 | `markFailed()` imediatamente (permanente) |
| 401/403 | `markFailed()` imediatamente (permanente) |
| 429 | Retry com backoff (`withRetry`) |
| 5xx | Retry com backoff (`withRetry`) |
| Network | Retry com backoff (`withRetry`) |
