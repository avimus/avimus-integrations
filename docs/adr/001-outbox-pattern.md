# ADR-001: Outbox Pattern para Entrega Confiável

**Status**: Aceito  
**Data**: 2026-06-29

## Contexto

O serviço precisa garantir que eventos do Tasy sejam entregues ao Ávimus sem perda de dados, mesmo em caso de falha transitória da API Ávimus ou do próprio processo.

## Decisão

Usar o **Transactional Outbox Pattern**: eventos transformados são primeiro gravados na tabela `outbox` (PostgreSQL) com status `pendente`, e um worker separado é responsável pela entrega ao Ávimus.

## Consequências

**Positivas**:
- Desacopla o ciclo de polling da entrega — falha no Ávimus não bloqueia o fetch do próximo ciclo
- Permite retry com backoff sem reprocessar o ERP
- Audit trail natural (status transitions)
- Idempotência: `hasRecentSuccess()` previne duplicação via cheque antes de cada entrega

**Negativas**:
- Latência adicional de até 1 minuto (intervalo do outbox worker)
- Dependência do PostgreSQL como broker durável

## Alternativas Consideradas

- **Entrega síncrona no ciclo de polling**: Descartada — falha no Ávimus perderia dados pois `last_synced_at` não seria atualizado, re-fetchando infinitamente os mesmos eventos
- **Redis/BullMQ**: Descartado — adiciona dependência de infraestrutura; PostgreSQL já está disponível
