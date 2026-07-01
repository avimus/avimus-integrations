# Briefing de Evolução — Ávimus Integrations

**Data**: 2026-06-30
**Contexto**: Documento gerado a partir de sessão de alinhamento estratégico.
**Finalidade**: Servir de entrada para o SpecKit gerar especificações, planos e tarefas das próximas features.

---

## 1. Contexto do Projeto Atual

### O que já existe e funciona

O repositório `avimus-integrations` possui um worker de background **100% implementado** que:

- Faz polling na API do Tasy ERP a cada 10 minutos
- Transforma os registros de atendimento em payloads para a API do Ávimus Patient Journey
- Persiste os registros numa tabela `outbox` com status `pendente`
- Entrega os payloads via HTTP PATCH para o Ávimus e marca como `enviado`
- Reprocessa falhas com retry exponencial (até 3 tentativas), depois marca como `falhou`
- Usa mutex para evitar ciclos sobrepostos
- Mascara CPF nos logs (LGPD) e criptografa dados sensíveis em repouso
- Mantém trilha de auditoria completa

### Stack atual do worker

- Node.js 20+ com TypeScript strict
- `pg` (PostgreSQL), `node-cron`, `axios`, `pino`, `zod`
- Sem framework web, sem Redis, sem filas externas
- Rodando como processo background (sem porta HTTP)

### Tabelas existentes no banco

```
sync_state     — last_synced_at por ERP
outbox         — registros pendente/enviado/falhou
audit_log      — trilha de auditoria de todos os acessos
```

### Ecossistema Ávimus (projetos já existentes)

| Projeto | Porta | Descrição |
|---|---|---|
| patient-journey/web | 3000 | Frontend do cliente final |
| patient-journey/api | 3001 | API principal do Patient Journey |
| patient-journey/admin | 3002 | Painel administrativo SaaS |
| avimus-integrations | — | Worker de integração (este projeto) |

### Decisão arquitetural já tomada

**Repositórios separados** — `avimus-integrations` é e deve continuar sendo um repositório independente do `patient-journey`. Os motivos são:

- Ciclos de deploy independentes
- Falha no worker não afeta o produto principal
- Times diferentes podem evoluir cada parte
- Escala e necessidades de recursos diferentes

**Banco compartilhado por schema** — os dois projetos usam o mesmo PostgreSQL, mas em schemas separados:

```
banco: avimus_prod
├── schema: public        ← patient-journey (patients, journeys, steps...)
└── schema: integrations  ← avimus-integrations (outbox, sync_state, tenants...)
```

---

## 2. Problema que precisa ser resolvido

### 2.1 O worker atual é single-tenant e hardcoded

Hoje o worker tem os mapeamentos de campos fixos no código. Não existe nenhuma interface para:

- Configurar quais ERPs estão conectados por cliente
- Definir visualmente quais campos do ERP mapeiam para quais campos do Ávimus (de-para)
- Monitorar o status dos ciclos de sincronização
- Reprocessar manualmente registros que falharam

### 2.2 A plataforma será multi-tenant

O Ávimus atende múltiplos hospitais/clínicas (tenants). Cada cliente tem seu próprio ERP com campos diferentes. Exemplo real do problema:

| Cliente | Campo identificador no ERP | Campo no Ávimus |
|---|---|---|
| Hospital A | `codigo_pessoa_fisica` | `cpf` |
| Hospital B | `cpf` | `cpf` |
| Hospital C | `documento` | `cpf` |
| Hospital D | `nr_cpf` | `cpf` |

O mesmo evento Tasy pode ter nome de campo diferente por cliente. O worker precisa saber, por tenant, como traduzir os campos.

### 2.3 Outros ERPs virão no futuro

O Tasy é o primeiro ERP integrado, mas virão outros: TOTVS, Sankhya, MV, Philips Tasy (versão cloud), Omie etc. A arquitetura de adapter já está preparada no código, mas o processo de cadastrar um novo ERP e seus mapeamentos ainda é manual (editar código e `.env`).

---

## 3. Objetivo da Evolução

Transformar o `avimus-integrations` de um worker single-tenant hardcoded em uma **plataforma de integração multi-tenant configurável via interface visual**, onde:

1. Cada cliente (tenant) tem sua própria configuração de ERP
2. Os mapeamentos de campos são definidos via drag-and-drop na interface do admin
3. O admin (3002) consegue monitorar, configurar e operar as integrações de cada cliente
4. Adicionar um novo ERP para um cliente não exige deploys ou edição de código

---

## 4. Features a Construir

### Feature 002 — Multi-tenant no Worker

**Objetivo**: Adicionar isolamento por tenant em toda a camada de dados e orquestração do worker.

**O que muda no banco**:

```sql
-- Nova tabela: tenants
CREATE TABLE integrations.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Nova tabela: erp_connections (configuração de ERP por tenant)
CREATE TABLE integrations.erp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES integrations.tenants(id),
  erp_name TEXT NOT NULL,           -- 'tasy', 'totvs', etc.
  base_url TEXT NOT NULL,
  timeout_ms INT DEFAULT 10000,
  credentials JSONB,                -- criptografado
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Nova tabela: field_mappings (de-para de campos por tenant + ERP)
CREATE TABLE integrations.field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES integrations.tenants(id),
  erp_name TEXT NOT NULL,
  source_field TEXT NOT NULL,       -- nome do campo no ERP
  target_field TEXT NOT NULL,       -- nome do campo esperado pelo worker
  transform TEXT,                   -- opcional: 'uppercase', 'strip_punctuation', etc.
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, erp_name, source_field)
);

-- Nova tabela: event_mappings (de-para de eventos por tenant + ERP)
CREATE TABLE integrations.event_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES integrations.tenants(id),
  erp_name TEXT NOT NULL,
  erp_event_code TEXT NOT NULL,     -- código do evento no ERP (ex: CONSULTA_REALIZADA)
  avimus_event_id TEXT NOT NULL,    -- integrationEventId do Ávimus
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, erp_name, erp_event_code)
);

-- Tabelas existentes ganham tenant_id
ALTER TABLE integrations.sync_state ADD COLUMN tenant_id UUID REFERENCES integrations.tenants(id);
ALTER TABLE integrations.outbox ADD COLUMN tenant_id UUID REFERENCES integrations.tenants(id);
ALTER TABLE integrations.audit_log ADD COLUMN tenant_id UUID REFERENCES integrations.tenants(id);
```

**O que muda no worker**:

- O cron loop passa a iterar por `(tenant, erp_connection)` ativos em vez de ler `.env`
- O adapter recebe a config do banco em vez de variáveis de ambiente fixas
- O transformer usa `field_mappings` do banco para traduzir campos
- O matcher usa `event_mappings` do banco para encontrar o step correto
- Todos os registros de `outbox`, `sync_state` e `audit_log` carregam `tenant_id`

**Restrições**:

- Um tenant com `is_active = false` não é processado no ciclo
- Uma `erp_connection` com `is_active = false` é ignorada pelo cron
- Sem `field_mappings` configurados para um tenant+ERP, o ciclo loga aviso e pula o tenant
- Isolamento total: um tenant não pode ver ou afetar dados de outro

---

### Feature 003 — Worker HTTP API

**Objetivo**: Expor uma API HTTP leve no worker para que o admin (3002) possa consultar e operar as integrações.

**Porta**: 3003 (configurável via `WORKER_API_PORT`)

**Autenticação**: Bearer token compartilhado entre worker e admin (variável `WORKER_API_SECRET`)

**Endpoints necessários**:

```
# Tenants
GET    /tenants                          — lista todos os tenants
POST   /tenants                          — cria novo tenant
PATCH  /tenants/:id                      — ativa/desativa tenant

# Conexões ERP
GET    /tenants/:tenantId/erp-connections         — lista ERPs do tenant
POST   /tenants/:tenantId/erp-connections         — adiciona ERP ao tenant
PATCH  /tenants/:tenantId/erp-connections/:id     — edita/desativa conexão
DELETE /tenants/:tenantId/erp-connections/:id     — remove conexão

# Mapeamentos de campos (de-para)
GET    /tenants/:tenantId/field-mappings/:erpName  — lista de-para de campos
PUT    /tenants/:tenantId/field-mappings/:erpName  — salva de-para completo (substitui)

# Mapeamentos de eventos
GET    /tenants/:tenantId/event-mappings/:erpName  — lista de-para de eventos
PUT    /tenants/:tenantId/event-mappings/:erpName  — salva de-para de eventos

# Monitoramento
GET    /tenants/:tenantId/sync-status     — último sync, próximo sync, contadores
GET    /tenants/:tenantId/outbox          — registros com filtro: status, data, limit
POST   /tenants/:tenantId/outbox/:id/retry — força retry de registro falhou

# Health
GET    /health                            — status do worker, conexão com banco
```

**Restrições**:

- A API não substitui o worker — ambos rodam no mesmo processo Node.js
- Sem autenticação de usuário (o admin já autenticou o usuário antes de chamar)
- Todos os endpoints retornam JSON
- Paginação via `limit` e `cursor` nos endpoints de listagem
- CPF sempre mascarado nas respostas

---

### Feature 004 — Interface de Integrações no Admin (3002)

**Objetivo**: Adicionar uma seção "Integrações" no admin SaaS existente que permita gerenciar toda a configuração e monitoramento via interface visual.

**Localização**: Nova rota `/integrations` no admin (3002), chamando a Worker API (3003)

**Seções da interface**:

#### 4.1 — Gerenciar ERPs por tenant

```
┌──────────────────────────────────────────────────────────────┐
│ Integrações — Hospital São Lucas              [+ Novo ERP]   │
├──────────────────────────────────────────────────────────────┤
│ ● Tasy    http://192.168.80.190:9001   Ativo   [Configurar] │
│            Último sync: há 4 min                [Desativar]  │
├──────────────────────────────────────────────────────────────┤
│ ○ TOTVS   (não configurado)                    [Conectar]   │
└──────────────────────────────────────────────────────────────┘
```

#### 4.2 — Mapeamento de campos (drag-and-drop)

Interface visual onde o usuário arrasta campos do ERP para campos esperados pelo Ávimus:

```
┌──────────────────────────────────────────────────────────────────┐
│  De-Para de Campos — Tasy × Hospital São Lucas      [Salvar]     │
├───────────────────────────┬──────────────────────────────────────┤
│  Campos do Tasy (entrada) │  Campos do Ávimus (saída)            │
├───────────────────────────┼──────────────────────────────────────┤
│ ┌───────────────────────┐ │  ┌──────────────┐                   │
│ │ codigo_pessoa_fisica  │━━━━▶│ cpf          │                   │
│ └───────────────────────┘ │  └──────────────┘                   │
│                           │                                      │
│ ┌───────────────────────┐ │  ┌──────────────┐                   │
│ │ protocolo             │━━━━▶│ protocolId   │                   │
│ └───────────────────────┘ │  └──────────────┘                   │
│                           │                                      │
│ ┌───────────────────────┐ │  ┌──────────────┐                   │
│ │ data_atendimento      │━━━━▶│ eventDate    │                   │
│ └───────────────────────┘ │  └──────────────┘                   │
│                           │                                      │
│ ┌───────────────────────┐ │  ┌──────────────┐                   │
│ │ nome_profissional     │ │  │ specialty    │  (não mapeado)    │
│ └───────────────────────┘ │  └──────────────┘                   │
└───────────────────────────┴──────────────────────────────────────┘
```

- Campos não mapeados ficam visíveis mas sem linha de conexão
- Clique numa linha remove o mapeamento
- Campos obrigatórios (`cpf`, `protocolId`, `eventDate`) são destacados em vermelho se não mapeados
- Salvar envia `PUT /tenants/:id/field-mappings/tasy` com o JSON de mapeamentos

#### 4.3 — Mapeamento de eventos

Tabela editável para relacionar códigos de evento do ERP com eventos do Ávimus:

```
┌──────────────────────────────────────────────────────────────┐
│ De-Para de Eventos — Tasy × Hospital São Lucas  [+ Adicionar]│
├─────────────────────────┬──────────────────────┬─────────────┤
│ Código Tasy             │ Evento Ávimus         │             │
├─────────────────────────┼──────────────────────┼─────────────┤
│ CONSULTA_REALIZADA      │ consulta_realizada    │ [Remover]  │
│ EXAME_COLETADO          │ exame_laboratorial    │ [Remover]  │
│ ALTA_HOSPITALAR         │ alta_concedida        │ [Remover]  │
└─────────────────────────┴──────────────────────┴─────────────┘
```

#### 4.4 — Monitoramento

```
┌─────────────────────────────────────────────────────────────┐
│ Status — Hospital São Lucas / Tasy                          │
│                                                             │
│ ● Ativo    Último ciclo: 14:20 ✅    Próximo: 14:30        │
│                                                             │
│ Hoje       Buscados: 47   Transformados: 45   Enviados: 45 │
│            Pendentes: 0   Falhados: 0                       │
└─────────────────────────────────────────────────────────────┘
```

#### 4.5 — Reprocessar falhas

```
┌──────────────────────────────────────────────────────────────────┐
│ Registros com falha — Hospital São Lucas                         │
├───────────┬─────────────────────┬────────────┬───────────────────┤
│ CPF       │ Erro                │ Tentativas │                   │
├───────────┼─────────────────────┼────────────┼───────────────────┤
│ ***456-** │ 503 Unavailable     │ 3/3        │ [Forçar retry]   │
│ ***789-** │ 404 Step not found  │ 3/3        │ [Forçar retry]   │
└───────────┴─────────────────────┴────────────┴───────────────────┘
```

**Stack da interface** (admin já usa, manter consistência):

- React + TypeScript
- `@dnd-kit/core` e `@dnd-kit/sortable` para drag-and-drop
- Fetch nativo ou axios para chamar a Worker API (3003)

**Restrições**:

- O admin nunca acessa o banco diretamente — tudo via Worker API (3003)
- Cada página de configuração é escopada por tenant (seletor de tenant no topo)
- Nenhuma ação destrutiva (remover ERP, limpar outbox) sem confirmação modal

---

## 5. Dependências entre Features

```
Feature 002 (Multi-tenant)
    ↓ bloqueia
Feature 003 (Worker API)
    ↓ bloqueia
Feature 004 (Interface Admin)
```

Não é possível construir a API sem o modelo multi-tenant. Não é possível construir a interface sem a API. A ordem de implementação é obrigatoriamente 002 → 003 → 004.

---

## 6. Princípios que devem ser mantidos (Constitution)

Os princípios abaixo foram definidos na constitution do projeto e devem guiar todas as novas features:

1. **HTTP-Only Decoupling** — toda comunicação externa via HTTP. Nenhum SDK de ERP.
2. **ERP-Plugin Architecture** — adicionar ERP novo = novo adapter + registro. Zero mudança no core.
3. **Simplicity Over Engineering** — sem Redis, sem filas externas, sem over-engineering.
4. **Observability** — logs estruturados, correlation IDs, CPF sempre mascarado.
5. **Data Resilience** — outbox + retry + dead-letter. Nenhum registro perdido silenciosamente.

Adicionalmente, para as novas features:

6. **Multi-tenant isolation** — nenhum tenant acessa dados de outro. `tenant_id` obrigatório em todas as queries.
7. **Configuration over code** — mapeamentos vivem no banco, não no código.
8. **Admin as consumer** — o admin (3002) é apenas um cliente da Worker API (3003). Nunca acessa o banco diretamente.

---

## 7. O que NÃO está no escopo desta evolução

- Autenticação própria na Worker API (o admin já autentica o usuário)
- Dashboard de analytics avançado (gráficos históricos, relatórios)
- Webhook de notificação (email/Slack quando registro falha)
- Suporte a transformações complexas de campos (apenas mapeamento direto 1:1 por enquanto)
- Implementação de adapters para ERPs além do Tasy (a arquitetura suporta, mas não é escopo agora)
- Multi-região ou HA (alta disponibilidade) — deployamento single-instance por enquanto

---

## 8. Ambiente de Trabalho desta Sessão

- Repositório principal desta sessão: `avimus-integrations` (`C:\Projetos\avimus-integrations`)
- O repositório do `patient-journey` (admin 3002) será adicionado a esta sessão via `add_repo` antes de iniciar a Feature 004
- As alterações no admin (3002) serão feitas na mesma sessão, em branch separada

---

## 9. Resumo das Próximas Features para o SpecKit

| # | Feature | Bloqueia | Repos afetados |
|---|---|---|---|
| 002 | Multi-tenant no Worker | 003, 004 | avimus-integrations |
| 003 | Worker HTTP API | 004 | avimus-integrations |
| 004 | Interface Admin | — | patient-journey (admin) |
