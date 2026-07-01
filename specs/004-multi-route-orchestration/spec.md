# Feature Specification: Multi-route ERP/Avimus Orchestration

**Feature Branch**: `004-multi-route-orchestration`

**Created**: 2026-06-30

**Status**: Draft

---

## Clarifications

### Session 2026-06-30

- Q: Quais dados do evento ERP são necessários para iniciar uma jornada no Avimus? → A: `cpf` + `protocolId` — a jornada nasce com um protocolo associado.
- Q: Como tratar os mapeamentos existentes na migration? → A: Reset limpo — `field_mappings` e `event_mappings` existentes são removidos; cada tenant reconfigura via admin após a migration.
- Q: Como o admin recebe o resultado da introspection? → A: Síncrono — a Worker API chama o ERP e retorna os campos na mesma resposta HTTP com timeout de 15 segundos.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Configurar múltiplos endpoints por conexão ERP (Priority: P1)

O administrador de integrações de um hospital precisa conectar dois endpoints diferentes do Tasy — `/eventos/start_protocolo` (para início de protocolo) e `/eventos/internacao` (para internações). Cada endpoint retorna campos com nomes distintos. O admin precisa cadastrar cada endpoint separadamente, com seus próprios mapeamentos de campos e de eventos, sem que um interfira no outro.

**Why this priority**: É o núcleo desta feature. Sem isso, hospitais com múltiplos fluxos de evento no mesmo ERP ficam bloqueados.

**Independent Test**: Cadastrar dois endpoints para a mesma erp_connection; verificar que cada um executa seu ciclo de sync independentemente e usa seus próprios field_mappings; alterar o mapeamento de um sem afetar o outro.

**Acceptance Scenarios**:

1. **Given** uma erp_connection existente para `tasy`, **When** o admin cadastra um segundo endpoint `/eventos/internacao` com field_mappings próprios, **Then** o worker percorre ambos os endpoints no ciclo de sync e cada um usa apenas seus próprios mapeamentos.
2. **Given** dois endpoints ativos na mesma connection, **When** um endpoint é desativado, **Then** o worker continua sincronizando apenas o endpoint ativo, sem interrupção.
3. **Given** dois endpoints com campos de mesmo nome mas semânticas diferentes (ex: `tipo` em endpoint A significa `event_type`; `tipo` em endpoint B significa `specialty`), **When** cada endpoint tem seus próprios field_mappings, **Then** os dados são transformados corretamente por endpoint.

---

### User Story 2 — Descoberta automática de campos do ERP (Priority: P2)

Ao configurar o mapeamento de um endpoint, o administrador não sabe de cabeça os nomes exatos dos campos que o ERP retorna. Ele precisa acionar uma chamada de descoberta que busca um registro de exemplo do endpoint e lista os nomes dos campos disponíveis — para que ele possa fazer o mapeamento sem digitar nada manualmente.

**Why this priority**: Reduz drasticamente o tempo de onboarding de novos clientes e elimina erros de digitação nos nomes de campos.

**Independent Test**: Acionar a descoberta para um endpoint configurado; verificar que a resposta contém a lista de nomes de campos extraídos de um registro real do ERP.

**Acceptance Scenarios**:

1. **Given** um endpoint ERP configurado com URL e token válidos, **When** o admin aciona a descoberta de campos, **Then** o sistema retorna a lista de nomes de campos presentes no primeiro registro retornado pelo ERP.
2. **Given** o ERP retorna um payload aninhado (objeto dentro de objeto), **When** a descoberta é acionada, **Then** os campos são retornados com notação de ponto (ex: `paciente.cpf`, `paciente.nome`) para indicar a hierarquia.
3. **Given** o ERP está inacessível no momento da descoberta, **When** a descoberta é acionada, **Then** o sistema retorna erro descritivo após 15 segundos sem travar a interface, e o admin pode tentar novamente.

---

### User Story 3 — Múltiplas ações no Avimus por mapeamento de evento (Priority: P2)

Hoje o worker só sabe executar uma ação no Avimus: completar uma etapa (`PATCH /steps/:id/complete`). O hospital precisa que certos eventos do ERP disparem outras ações — como iniciar uma jornada para um paciente ainda sem jornada ativa. O mapeamento de evento deve determinar não só qual evento do Avimus acionar, mas qual ação executar.

**Why this priority**: Permite cobrir fluxos completos do ciclo de atendimento (admissão → alta), não apenas atualizações de etapas intermediárias.

**Independent Test**: Configurar um event_mapping com ação `start_journey`; processar um evento com esse código no ERP; verificar que o worker tenta criar uma jornada no Avimus, não completar uma etapa.

**Acceptance Scenarios**:

1. **Given** um event_mapping configurado com ação `start_journey`, **When** o worker processa um evento com esse código, **Then** ele chama a operação de início de jornada no Avimus com os dados do evento transformados.
2. **Given** um event_mapping configurado com ação `complete_step`, **When** o worker processa esse evento, **Then** o comportamento é idêntico ao atual (localiza paciente → jornada → etapa → completa).
3. **Given** um event_mapping com ação desconhecida ou não implementada, **When** o worker processa o evento, **Then** o registro vai para o outbox com status `falhou` e o erro é registrado no audit_log — sem travar outros eventos.
4. **Given** a ação é `start_journey` mas o paciente não tem cadastro no Avimus, **When** o worker tenta executar, **Then** o registro falha com erro descritivo e fica disponível para retry manual.

---

### User Story 4 — Visibilidade de rotas e ações no admin (Priority: P3)

O administrador precisa ver, para cada conexão, quais endpoints estão configurados, qual rota completa está sendo chamada no ERP, e qual ação Avimus cada mapeamento de evento vai executar — tudo sem precisar abrir código ou banco de dados.

**Why this priority**: Visibilidade operacional. O admin precisa saber o que está acontecendo para diagnosticar problemas.

**Independent Test**: Acessar o sync-status de um tenant com múltiplos endpoints; verificar que cada endpoint aparece com sua URL completa e contadores individuais de sync.

**Acceptance Scenarios**:

1. **Given** dois endpoints ativos para a mesma connection, **When** o admin consulta o sync-status, **Then** cada endpoint aparece separadamente com `fetch_url`, `last_synced_at` e contadores do dia individuais.
2. **Given** um event_mapping configurado, **When** o admin lista os mapeamentos de eventos de um endpoint, **Then** a resposta inclui o campo `avimus_action` indicando qual ação será executada.

---

### Edge Cases

- O que acontece se dois endpoints do mesmo ERP retornarem o mesmo `eventId` para registros diferentes? O `eventId` do adapter deve ser prefixado com o endpoint para garantir unicidade.
- O que acontece se o ERP retornar um payload vazio no momento da descoberta? Retornar erro amigável pedindo para tentar novamente.
- O que acontece se um endpoint é deletado enquanto o cron está em execução? O cron deve verificar `is_active` no início de cada iteração e pular endpoints desativados.
- Após a migration de reset limpo, o worker não processa nenhum tenant sem endpoints configurados — exibe aviso no audit_log e aguarda reconfiguração via admin.
- O que acontece se a ação `start_journey` cria uma jornada duplicada? O Avimus deve ser consultado antes de criar — se jornada ativa já existe, usar a existente.

---

## Requirements *(mandatory)*

### Functional Requirements

**Gerenciamento de endpoints**

- **FR-001**: O sistema DEVE permitir cadastrar N endpoints por `erp_connection`, cada um com: caminho da rota, status ativo/inativo, e autenticação própria opcional.
- **FR-002**: Cada endpoint DEVE ter seu próprio conjunto isolado de `field_mappings` e `event_mappings`, identificado por `endpoint_id`.
- **FR-003**: O worker DEVE percorrer todos os endpoints ativos de uma connection durante o ciclo de sync, processando cada um independentemente.
- **FR-004**: Desativar um endpoint DEVE interromper seu processamento sem afetar outros endpoints da mesma connection.
- **FR-005**: A Worker API DEVE expor endpoints CRUD para gerenciar os endpoints de uma erp_connection.

**Descoberta de campos**

- **FR-006**: A Worker API DEVE expor uma rota de introspection que, dado um `endpoint_id`, chame o ERP e retorne a lista de nomes de campos do primeiro registro.
- **FR-007**: Para payloads aninhados, a introspection DEVE retornar os campos com notação de ponto (ex: `paciente.cpf`).
- **FR-008**: A introspection é síncrona com timeout de 15 segundos; erros de conexão ou timeout DEVEM retornar mensagem descritiva sem travar o sistema.

**Múltiplas ações Avimus**

- **FR-009**: O `event_mapping` DEVE incluir um campo `avimus_action` com os valores: `complete_step` (atual) e `start_journey` (novo).
- **FR-010**: O worker DEVE executar a ação correta no Avimus com base no `avimus_action` do event_mapping.
- **FR-011**: A ação `start_journey` DEVE enviar `cpf` e `protocolId` ao Avimus para criar a jornada; DEVE verificar se o paciente já tem jornada ativa com esse protocolo antes de criar uma nova.
- **FR-012**: Ações desconhecidas ou falhas de execução DEVEM resultar em registro `falhou` no outbox, com o erro registrado no audit_log.
- **FR-013**: Cada ação Avimus DEVE ser implementada como módulo independente e extensível — adicionar nova ação não deve exigir alteração no core do worker.

**Visibilidade**

- **FR-014**: O sync-status DEVE retornar contadores por endpoint (não só por erp_name).
- **FR-015**: Os mapeamentos de evento DEVEM incluir `avimus_action` na resposta da Worker API.

**Segurança e isolamento (mantidos)**

- **FR-016**: Todos os novos recursos DEVEM filtrar por `tenant_id` em toda query — cross-tenant é bug crítico.
- **FR-017**: Credenciais de autenticação de endpoints DEVEM ser criptografadas antes de persistir, nunca retornadas nas respostas da API.

### Key Entities

- **ErpEndpoint**: Representa uma rota específica de um ERP dentro de uma `erp_connection`. Atributos: `id`, `connection_id`, `path` (ex: `/eventos/start_protocolo`), `credentials` (JSON criptografado, opcional), `is_active`, `created_at`.
- **FieldMapping** (atualizado): Passa a ser keyed por `endpoint_id` em vez de `(tenant_id, erp_name)`.
- **EventMapping** (atualizado): Passa a ser keyed por `endpoint_id`; ganha o campo `avimus_action` (enum: `complete_step`, `start_journey`).
- **AvimusAction**: Abstração de uma operação executável no Avimus (módulo independente por tipo de ação). A ação `start_journey` requer `cpf` + `protocolId` mapeados nos field_mappings do endpoint; a ação `complete_step` mantém o comportamento atual.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Um administrador consegue configurar dois endpoints distintos para o mesmo ERP de um tenant em menos de 5 minutos, sem assistência técnica.
- **SC-002**: A descoberta de campos retorna resultado em menos de 10 segundos para um endpoint acessível.
- **SC-003**: O worker processa eventos de múltiplos endpoints da mesma connection sem regressão no throughput atual (eventos por ciclo).
- **SC-004**: 100% dos event_mappings com `avimus_action` definido executam a ação correta — zero execuções da ação errada.
- **SC-005**: Falha em um endpoint não interrompe o processamento dos demais endpoints do mesmo tenant no mesmo ciclo.
- **SC-006**: A adição de uma nova ação Avimus no futuro não exige alteração em mais de 2 arquivos do worker (extensibilidade).

---

## Assumptions

- O Avimus Patient Journey API (3001) já expõe ou vai expor uma rota para iniciar jornadas; se não existir ainda, a ação `start_journey` fará parte do scope da implementação apenas no worker — a rota do Avimus é pré-requisito externo.
- Payloads dos endpoints ERP são JSON planos ou com um nível de aninhamento; arrays de objetos no nível raiz serão tratados como lista de registros a processar.
- A autenticação de cada endpoint ERP segue o mesmo padrão do atual: Bearer token no header `Authorization`, armazenado como `{"token": "..."}` no campo `credentials`.
- A migration de dados aplica reset limpo: `field_mappings` e `event_mappings` existentes são removidos; cada tenant reconhfigura seus mapeamentos via admin após o deploy. Dados de `outbox`, `sync_state` e `audit_log` são preservados.
- O `sync_state` passa a ser por `endpoint_id` (em vez de por `erp_name`), garantindo que cada endpoint tenha seu próprio `last_synced_at`.
- Scope de ações Avimus nesta feature: `complete_step` (existente) e `start_journey` (nova). Outras ações futuras são extensões — não estão no escopo.
