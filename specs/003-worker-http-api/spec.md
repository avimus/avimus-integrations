# Feature Specification: Worker HTTP API

**Feature Branch**: `003-worker-http-api`

**Created**: 2026-06-30

**Status**: Draft

**Input**: User description: "Quero expor uma API HTTP leve no worker avimus-integrations para que o admin (patient-journey/admin, porta 3002) consiga consultar e operar as integrações."

## Clarifications

### Session 2026-06-30

- Q: O `DELETE /erp-connections/:id` deve apagar fisicamente o registro ou fazer soft delete (`is_active = false`)? → A: Soft delete — seta `is_active = false` e preserva o registro; outbox pendente não é afetado.
- Q: As chamadas de 3002 para 3003 partem do browser (client-side) ou do servidor do admin (server-side)? → A: Server-side — o servidor do admin (3002) faz proxy para 3003; CORS na Worker API não é necessário e o WORKER_API_SECRET nunca é exposto ao browser.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Configurar Tenants e Conexões ERP (Priority: P1)

O administrador do Ávimus precisa criar tenants, vincular conexões de ERP e ativar/desativar essas configurações sem acesso direto ao banco de dados. Ele usa o painel admin (3002) que por sua vez chama a Worker API (3003). Toda operação de escrita ou leitura de configuração passa exclusivamente pela API.

**Why this priority**: É o bloco fundamental. Sem tenants e conexões configuradas, nenhuma sincronização acontece e as outras histórias não têm dados para operar.

**Independent Test**: Criar um tenant via `POST /tenants`, vincular uma conexão ERP via `POST /tenants/:id/erp-connections`, verificar que ambos aparecem nos endpoints de listagem correspondentes e que ativar/desativar via `PATCH` reflete corretamente.

**Acceptance Scenarios**:

1. **Given** a API está rodando na porta 3003 com Bearer token válido, **When** o admin envia `POST /tenants` com `{ name, slug }`, **Then** retorna `201` com o tenant criado incluindo `id` gerado.
2. **Given** um tenant existe, **When** o admin envia `POST /tenants/:tenantId/erp-connections` com `{ erp_name, base_url, timeout_ms, credentials }`, **Then** retorna `201` com a conexão criada.
3. **Given** uma conexão ERP ativa, **When** o admin envia `PATCH /tenants/:tenantId/erp-connections/:id` com `{ is_active: false }`, **Then** retorna `200` e o worker não inclui essa conexão no próximo ciclo de sync.
4. **Given** uma requisição sem Bearer token ou com token inválido, **When** qualquer endpoint é chamado, **Then** retorna `401 Unauthorized`.
5. **Given** um `tenantId` inexistente, **When** qualquer endpoint de tenant é chamado, **Then** retorna `404 Not Found`.

---

### User Story 2 — Gerenciar Mapeamentos de Campos e Eventos (Priority: P2)

O administrador configura o de-para de campos entre o ERP e o Ávimus (ex: `codigo_pessoa_fisica` → `cpf`) e também mapeia os códigos de evento do ERP para os eventos do Ávimus. Esses mapeamentos são salvos em bloco — um `PUT` substitui toda a configuração de mapeamento para aquele par tenant+ERP.

**Why this priority**: Sem mapeamentos configurados, o worker loga aviso e pula o tenant. Os mapeamentos são o coração da customização por cliente.

**Independent Test**: Salvar um conjunto de `field_mappings` via `PUT /tenants/:id/field-mappings/tasy`, depois consultá-los via `GET`, verificar que o conteúdo foi substituído integralmente. Repetir para `event-mappings`.

**Acceptance Scenarios**:

1. **Given** um tenant com conexão Tasy, **When** o admin envia `PUT /tenants/:tenantId/field-mappings/tasy` com array de mapeamentos, **Then** retorna `200` e os mapeamentos anteriores são substituídos integralmente.
2. **Given** mapeamentos existentes, **When** o admin consulta `GET /tenants/:tenantId/field-mappings/tasy`, **Then** retorna `200` com a lista completa de mapeamentos do par tenant+ERP.
3. **Given** um tenant com conexão Tasy, **When** o admin envia `PUT /tenants/:tenantId/event-mappings/tasy` com mapeamentos de eventos, **Then** retorna `200` e os eventos são substituídos.
4. **Given** o `PUT` enviado com array vazio, **When** processado, **Then** todos os mapeamentos existentes para aquele par são removidos e o worker passa a logar aviso ao processar o tenant (sem field_mappings).

---

### User Story 3 — Monitorar Sincronização e Reprocessar Falhas (Priority: P3)

O administrador consulta o status do último ciclo de sync de um tenant, visualiza os registros do outbox com filtros de status e data, e força o retry manual de registros que falharam após esgotar as tentativas automáticas.

**Why this priority**: Operação e suporte. Permite ao time identificar e corrigir falhas sem acesso direto ao banco.

**Independent Test**: Consultar `GET /tenants/:tenantId/sync-status`, verificar campos de último sync e próximo previsto. Buscar `GET /tenants/:tenantId/outbox?status=falhou` e confirmar que `POST /tenants/:tenantId/outbox/:id/retry` volta o registro para `pendente`.

**Acceptance Scenarios**:

1. **Given** um tenant com histórico de sync, **When** o admin consulta `GET /tenants/:tenantId/sync-status`, **Then** retorna `200` com `last_synced_at`, `next_sync_at` (estimado), `fetched_today`, `enqueued_today`, `delivered_today`, `failed_today`.
2. **Given** registros no outbox, **When** o admin consulta `GET /tenants/:tenantId/outbox?status=falhou&limit=20`, **Then** retorna lista paginada com CPF mascarado (ex: `***456-**`) em todos os registros.
3. **Given** um registro com status `falhou`, **When** o admin envia `POST /tenants/:tenantId/outbox/:id/retry`, **Then** o status volta para `pendente`, `attempt_count` é zerado e o outbox-worker processa na próxima rodada.
4. **Given** `POST .../retry` chamado para registro com status `enviado` (não falhou), **When** processado, **Then** retorna `409 Conflict` — retry não permitido para registros já entregues.
5. **Given** listagem com cursor, **When** o admin envia `GET /tenants/:tenantId/outbox?cursor=<opaque_cursor>`, **Then** retorna a próxima página de resultados ordenados por `created_at DESC`.

---

### User Story 4 — Health Check (Priority: P1)

O admin (3002) e sistemas de monitoramento externos verificam se o worker está operacional antes de exibir dados ou disparar alertas.

**Why this priority**: P1 compartilhado com US1 — é o endpoint mais simples e serve como sinal de vida do processo. Sem ele, o admin não sabe se a API está no ar.

**Independent Test**: Chamar `GET /health` sem autenticação e verificar resposta `200` com status do processo e da conexão com o banco.

**Acceptance Scenarios**:

1. **Given** o worker está rodando e o banco acessível, **When** `GET /health` é chamado (sem Bearer token), **Then** retorna `200` com `{ status: "ok", database: "connected", uptime_seconds: <número> }`.
2. **Given** o banco está inacessível, **When** `GET /health` é chamado, **Then** retorna `503 Service Unavailable` com `{ status: "degraded", database: "disconnected" }`.

---

### Edge Cases

- Requisição com Bearer token malformado (não começa com `Bearer `) retorna `401`.
- `POST /tenants` com `slug` duplicado retorna `409 Conflict`.
- `DELETE /tenants/:tenantId/erp-connections/:id` é um soft delete (`is_active = false`) — o registro permanece no banco. Outbox pendente não é afetado; o outbox-worker processa os registros existentes normalmente.
- Listagem de outbox com `limit` maior que o máximo permitido (ex: >100) retorna `400 Bad Request`.
- CPF nunca aparece em texto plano em nenhuma resposta — sempre mascarado no formato `***XXX-**`.
- Credenciais do ERP (`credentials`) nunca retornam nas respostas — campo omitido ou substituído por `"[encrypted]"`.
- Retry em registro com `attempt_count` já zerado que nunca falhou: retorna `409 Conflict`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A API DEVE iniciar na porta definida por `WORKER_API_PORT` (padrão: 3003) no mesmo processo Node.js do worker, sem substituir o cron.
- **FR-002**: Todos os endpoints (exceto `GET /health`) DEVEM exigir cabeçalho `Authorization: Bearer <token>` onde o token é comparado com `WORKER_API_SECRET`. Requisições sem token ou com token inválido recebem `401`.
- **FR-003**: `GET /health` DEVE ser acessível sem autenticação e retornar o estado do processo e da conexão com o banco.
- **FR-004**: A API DEVE expor os endpoints de gerenciamento de tenants: listar (`GET /tenants`), criar (`POST /tenants`), e atualizar (`PATCH /tenants/:id`).
- **FR-005**: A API DEVE expor os endpoints de conexões ERP por tenant: listar (`GET`), criar (`POST`), atualizar (`PATCH`) e remover (`DELETE`). O `DELETE` realiza **soft delete** — seta `is_active = false` e preserva o registro no banco; equivale semanticamente a `PATCH { is_active: false }` mas sinaliza remoção permanente da configuração.
- **FR-006**: A API DEVE expor os endpoints de mapeamentos de campos (`GET` e `PUT /tenants/:tenantId/field-mappings/:erpName`) onde o `PUT` substitui integralmente o conjunto de mapeamentos do par tenant+ERP.
- **FR-007**: A API DEVE expor os endpoints de mapeamentos de eventos (`GET` e `PUT /tenants/:tenantId/event-mappings/:erpName`) com mesma semântica de substituição integral.
- **FR-008**: A API DEVE expor `GET /tenants/:tenantId/sync-status` retornando `last_synced_at`, estimativa de `next_sync_at`, e contadores do dia (`fetched`, `enqueued`, `delivered`, `failed`).
- **FR-009**: A API DEVE expor `GET /tenants/:tenantId/outbox` com filtros opcionais por `status` e `date`, paginação por `limit` (máximo 100) e `cursor`.
- **FR-010**: A API DEVE expor `POST /tenants/:tenantId/outbox/:id/retry` que volta o registro para `pendente` e zera `attempt_count`. DEVE retornar `409` se o registro não estiver em status `falhou`.
- **FR-011**: Todos os endpoints de listagem DEVEM implementar paginação baseada em cursor opaco, retornando `next_cursor` quando houver mais resultados.
- **FR-012**: Nenhuma resposta da API DEVE expor CPF em texto plano — sempre mascarado no formato `***XXX-**` (três asteriscos, três dígitos centrais, hífen, dois asteriscos).
- **FR-013**: O campo `credentials` de conexões ERP NUNCA DEVE aparecer nas respostas — omitido ou substituído por `"[encrypted]"`.
- **FR-014**: Todos os endpoints DEVEM retornar `Content-Type: application/json` e corpo JSON, inclusive em erros.
- **FR-015**: A API DEVE incluir `tenant_id` na query de cada operação de leitura/escrita para garantir isolamento — um tenant não pode acessar dados de outro mesmo com IDs válidos.

### Key Entities

- **Tenant**: Representa um cliente (hospital/clínica). Atributos: `id`, `name`, `slug`, `is_active`, `created_at`.
- **ErpConnection**: Configuração de um ERP para um tenant. Atributos: `id`, `tenant_id`, `erp_name`, `base_url`, `timeout_ms`, `is_active`, `created_at`. Campo `credentials` nunca exposto.
- **FieldMapping**: De-para de um campo ERP → campo Ávimus. Atributos: `id`, `tenant_id`, `erp_name`, `source_field`, `target_field`.
- **EventMapping**: De-para de código de evento ERP → `avimus_event_id`. Atributos: `id`, `tenant_id`, `erp_name`, `erp_event_code`, `avimus_event_id`, `description`.
- **OutboxRecord**: Registro de entrega ao Ávimus. Atributos: `id`, `tenant_id`, `status`, `event_type`, `attempt_count`, `last_error`, `created_at`. Campo `aggregate_id` (CPF) sempre mascarado.
- **SyncStatus**: Snapshot do estado de sincronização de um par tenant+ERP. Campos: `last_synced_at`, `next_sync_at`, `fetched_today`, `enqueued_today`, `delivered_today`, `failed_today`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O admin (3002) consegue criar um novo tenant e configurar sua primeira conexão ERP em menos de 2 minutos via interface, sem intervenção técnica.
- **SC-002**: 100% dos endpoints respondem em menos de 500ms para operações sobre conjuntos de até 1.000 registros.
- **SC-003**: Nenhuma resposta da API expõe CPF em texto plano — verificável por inspeção automática de todas as respostas de listagem do outbox.
- **SC-004**: O health check responde em menos de 200ms e reflete corretamente a indisponibilidade do banco em até 5 segundos após a falha.
- **SC-005**: Um registro com status `falhou` pode ser recolocado em fila pelo admin em no máximo 3 cliques na interface, sem acesso ao banco.
- **SC-006**: Requisições de um tenant não retornam nem alteram dados de outro tenant — verificável por teste com dois tenants e IDs cruzados.

## Assumptions

- O token `WORKER_API_SECRET` é gerado e compartilhado manualmente entre o worker e o admin no deploy — não há rotação automática de token nesta versão.
- A estimativa de `next_sync_at` no sync-status é calculada com base em `last_synced_at + POLLING_INTERVAL_MINUTES`, sem considerar drift de cron.
- O campo `credentials` das conexões ERP não é retornado em nenhum endpoint — quem cadastrou a conexão é responsável por guardar as credenciais originais.
- A paginação por cursor usa `created_at + id` como base, garantindo estabilidade mesmo com inserções concorrentes.
- O worker e o admin rodam na mesma rede interna (não há exposição pública da porta 3003).
- As chamadas de 3002 para 3003 são server-side (servidor do admin faz proxy); CORS não é necessário na Worker API e o `WORKER_API_SECRET` nunca é enviado ao browser.
- Sem rate limiting nesta versão — o admin é o único consumidor esperado da API.
- O `DELETE` de uma `erp_connection` é soft delete (`is_active = false`); registros pendentes no outbox continuam sendo processados normalmente pelo outbox-worker.
- Contadores de `sync-status` (`fetched_today`, etc.) são derivados do `audit_log` do dia corrente (UTC).
