# Ávimus API Contract

**Date**: 2026-06-29

## Authentication

All requests require `Authorization: Bearer {AVIMUS_API_TOKEN}` header.

## Endpoints Used

### GET /api/v1/patients?cpf={cpf}

Search for a patient by CPF.

**Response** (200 OK):
```json
{
  "id": "patient-uuid",
  "cpf": "12345678901",
  "name": "Patient Name"
}
```

**Error**: 404 = patient not found → log "no match found", do not enqueue.

---

### GET /api/v1/journeys?patientId={id}&status=ativo

List active journeys for a patient.

**Response** (200 OK):
```json
[
  {
    "id": "journey-uuid",
    "patientId": "patient-uuid",
    "protocol": "PROTO-001",
    "status": "ativo"
  }
]
```

**Error**: 404 = no active journeys → log "no match found", do not enqueue.

---

### GET /api/v1/journeys/{journeyId}/steps

List steps in a journey.

**Response** (200 OK):
```json
[
  {
    "id": "step-uuid",
    "integrationEventId": "CONSULTA_REALIZADA",
    "status": "pendente"
  }
]
```

**Matching logic**: Find step where `integrationEventId` equals Tasy's `erpEventCode`.

---

### PATCH /api/v1/steps/{stepId}/complete

Mark a step as completed.

**Request Body**:
```json
{
  "result": "completed",
  "notes": "Sincronizado automaticamente via Tasy",
  "metadata": {
    "erpName": "tasy",
    "protocolId": "PROTO-001",
    "eventDate": "2026-06-29T10:00:00Z"
  }
}
```

**Response** (200 OK):
```json
{
  "id": "step-uuid",
  "status": "concluido"
}
```

**Error Responses**:
| Status | Meaning | Behavior |
|--------|---------|----------|
| 200 | Success | Mark outbox record as `enviado` |
| 404 | Step not found | Mark as `falhou` (permanent) |
| 429 | Rate limited | Retry with backoff |
| 5xx | Server error | Retry with backoff |
