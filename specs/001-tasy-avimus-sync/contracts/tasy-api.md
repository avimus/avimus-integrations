# Tasy Adapter API Contract

**Date**: 2026-06-29

## Tasy ERP Endpoint

**Base URL**: Configured via `TASY_BASE_URL` env var (default: `http://192.168.80.190:9001`)

### GET /atendimentos/recentes

Fetches recent patient appointment records since a given timestamp.

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since` | ISO 8601 string | Yes | Only return records created/updated after this timestamp |

**Response** (200 OK):
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

**Field Mapping to RawEvent**:
| Tasy Field | RawEvent Field | Notes |
|------------|----------------|-------|
| `protocolo` | `eventId` | Prefixed: `tasy-{protocolo}` |
| `cpf` | `cpf` | Encrypted at rest |
| `evento_codigo` | `erpEventCode` | Mapped to Ávimus `integration_event_id` |
| `data_atendimento` | `eventDate` | Parsed as `Date` |
| `tipo_atendimento` | `payload.appointmentType` | Transformer-specific |
| `especialidade` | `payload.specialty` | Transformer-specific |
| `nome_profissional` | `payload.professionalName` | Transformer-specific |

**Error Responses**:
| Status | Meaning | `transient` |
|--------|---------|-------------|
| 401 | Unauthorized | `false` |
| 404 | Endpoint not found | `false` |
| 500 | Server error | `true` |
| 503 | Service unavailable | `true` |
| Network error | Unreachable | `true` |
