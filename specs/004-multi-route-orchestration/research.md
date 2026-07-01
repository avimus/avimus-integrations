# Research — Multi-route ERP/Avimus Orchestration

## 1. Estrutura da tabela `erp_endpoints`

**Decision**: Nova tabela `erp_endpoints` como filho de `erp_connections`, com `path`, `credentials` próprias, e `is_active`.

**Rationale**: Mantém `erp_connections` como configuração da "conexão" (host, timeout, autenticação base), e `erp_endpoints` como configuração de cada "rota" específica dentro dessa conexão. Uma connection pode ter N endpoints ativos simultaneamente.

**Alternatives considered**:
- Adicionar coluna `endpoints JSONB` em `erp_connections`: rejeitado — impede queries SQL diretas em atributos de endpoint e dificulta indexação.
- Tabela flat com `(connection_id, path)` sem hierarquia: escolhida — mais simples do que nested JSON, suporta FK e índices.

---

## 2. Migração de `sync_state`, `field_mappings` e `event_mappings`

**Decision**:
- `sync_state` ganha coluna `endpoint_id UUID FK erp_endpoints(id)` substituindo a semântica de `erp_name` (que é mantida por compatibilidade mas passa a ser redundante).
- `field_mappings` e `event_mappings` têm a constraint `UNIQUE(tenant_id, erp_name, source_field)` substituída por `UNIQUE(endpoint_id, source_field)` / `UNIQUE(endpoint_id, erp_event_code)`.
- Migration aplica reset limpo: remove dados de `field_mappings` e `event_mappings` existentes e adiciona coluna `endpoint_id NOT NULL`.

**Rationale**: Reset limpo foi escolha do produto (clarification Q2). Simplifica a migration e evita dados órfãos.

**Rollout implication**: Após deploy, nenhum tenant processa eventos até reconfigurar endpoints + mappings via admin. Comunicar downtime de sincronização antes do deploy.

---

## 3. Introspection de campos — implementação

**Decision**: Rota `POST /tenants/:tenantId/erp-connections/:connId/endpoints/:endpointId/introspect` — o handler chama o ERP com o token do endpoint, extrai as chaves do primeiro objeto retornado, achata objetos aninhados com notação de ponto até 2 níveis.

**Rationale**: Síncrono com timeout de 15s (clarification Q3). O adapter existente (`TasyAdapter`) faz a chamada via `fetch` nativo — reutilizar o mesmo padrão. A extração de chaves funciona para qualquer formato JSON sem precisar conhecer o schema do ERP de antemão.

**Nested payload handling**: `flattenKeys(obj, prefix)` recursivo com profundidade máxima 2 (`a.b` mas não `a.b.c`) para evitar explosão de campos em payloads complexos.

**Alternatives considered**:
- Async com polling: rejeitado (clarification Q3).
- Chamar o adapter existente: possível, mas a introspection não precisa de `since` — faz uma chamada sem filtro de data para pegar a estrutura do payload.

---

## 4. Ações Avimus — padrão de extensibilidade

**Decision**: Map de handlers indexado por `avimus_action` string. Cada handler é uma função async independente com assinatura tipada.

```typescript
// src/services/avimus-actions/index.ts
const ACTION_HANDLERS: Record<string, AvimusActionHandler> = {
  complete_step: completeStepAction,
  start_journey: startJourneyAction,
};
```

**Rationale**: Adicionar nova ação = criar novo arquivo + registrar no map. Zero mudanças no core do worker. Cumpre SC-006 (≤2 arquivos para nova ação).

**Alternatives considered**:
- Switch/case no outbox-worker: rejeitado — viola Princípio II (condicional de ERP-específico no core).
- Plugin dinâmico via filesystem: over-engineering para o número atual de ações.

---

## 5. Isolamento multi-tenant com `endpoint_id` como chave

**Decision**: Toda query em `field_mappings` e `event_mappings` faz JOIN explícito `endpoint_id → erp_endpoints.connection_id → erp_connections.tenant_id = $tenantId`.

**Rationale**: `tenant_id` não estará mais diretamente em `field_mappings`, mas o isolamento é garantido via JOIN. O worker API valida o tenant antes de qualquer operação de endpoint.

**Implementation pattern**:
```sql
-- Garantia de isolamento via JOIN:
SELECT fm.*
FROM field_mappings fm
JOIN erp_endpoints ep ON fm.endpoint_id = ep.id
JOIN erp_connections ec ON ep.connection_id = ec.id
WHERE ec.tenant_id = $1  -- isolamento
  AND fm.endpoint_id = $2
```

---

## 6. Contrato `start_journey` no Avimus API

**Decision**: O worker chama `POST /api/v1/journeys` com `{ cpf, protocolId }`. Antes de criar, chama `GET /api/v1/journeys?cpf=<cpf>&protocolId=<protocolId>&status=ativo` para verificar existência. Se já existe, usa a jornada existente (idempotência).

**Rationale**: Clarification Q1 definiu que `cpf` + `protocolId` são os dados necessários. A verificação de existência prévia é requisito de FR-011.

**Note**: Esta rota no Avimus API (3001) pode ainda não existir — é pré-requisito externo identificado na spec. Se não existir, o `start_journey` handler deve logar erro descritivo e marcar o registro como `falhou` com mensagem "Avimus start_journey endpoint not available".
