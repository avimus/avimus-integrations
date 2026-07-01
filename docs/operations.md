# Operações — Avimus Integrations

## Variáveis de Ambiente

| Variável | Obrigatória | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `DATABASE_URL` | ✅ | — | Connection string PostgreSQL |
| `DB_POOL_MAX` | — | `10` | Máximo de conexões no pool |
| `AVIMUS_API_URL` | ✅ | — | URL base da API Ávimus |
| `AVIMUS_API_TOKEN` | ✅ | — | Bearer token para autenticação |
| `ENCRYPTION_KEY` | ✅ | — | Chave AES-256 em hex (64 chars) para CPF em repouso |
| `TASY_BASE_URL` | ✅ | — | URL base da API Tasy |
| `TASY_TIMEOUT_MS` | — | `10000` | Timeout HTTP para Tasy (ms) |
| `ERP_NAMES` | — | `tasy` | ERPs ativos, separados por vírgula |
| `NODE_ENV` | — | `development` | `development` / `staging` / `production` |
| `LOG_LEVEL` | — | `info` | `debug` / `info` / `warn` / `error` |
| `INITIAL_LOOKBACK_HOURS` | — | `24` | Janela de lookback no primeiro run |
| `MAX_RETRIES` | — | `3` | Tentativas de entrega ao Ávimus |
| `POLLING_INTERVAL_MINUTES` | — | `10` | Intervalo de polling do ERP |

Gere uma chave de criptografia segura com:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Setup Local

```bash
# 1. Instalar dependências
npm install

# 2. Configurar ambiente
cp .env.example .env
# Editar .env com valores reais

# 3. Rodar migrations
npm run db:migrate

# 4. Iniciar serviço em modo dev
npm run dev
```

## Migrations

O script `npm run db:migrate` é idempotente e rastreia versões aplicadas na tabela `schema_migrations`. Cada migration roda dentro de uma transação — falha parcial faz rollback automático.

```bash
npm run db:migrate
# Saída esperada:
# Skipping already-applied migration: 001_initial.sql
# All migrations already applied — nothing to run
```

## Testes

```bash
npm test                 # Roda todos os testes uma vez
npm run test:watch       # Modo watch (desenvolvimento)
npm run test:coverage    # Com relatório de cobertura
npm run typecheck        # Verificação de tipos TypeScript
```

## Monitoramento

### Logs Estruturados (JSON)

Todos os logs usam Pino com saída JSON. Campos-chave:

| Campo | Descrição |
|-------|-----------|
| `adapter` | Nome do ERP (ex: `"tasy"`) |
| `cycleId` | UUID do ciclo de sync atual |
| `correlationId` | UUID da entrega individual |
| `outboxId` | UUID do registro no outbox |
| `stepId` | ID do step no Ávimus |
| `error` | Mensagem de erro (CPF nunca aparece) |

### Ações de Audit Log

| `action` | Componente | Descrição |
|----------|-----------|-----------|
| `sync_cycle.start` | poller | Início do ciclo |
| `sync_cycle.complete` | poller | Ciclo concluído com sucesso |
| `sync_cycle.error` | poller | Ciclo falhou |
| `outbox.enqueue` | poller | Record enfileirado |
| `delivery.success` | outbox-worker | Entrega ao Ávimus concluída |
| `delivery.skipped_duplicate` | outbox-worker | Idempotência: step já concluído |
| `delivery.failed` | outbox-worker | Falha permanente após retries |

### Queries Úteis

```sql
-- Records pendentes há mais de 30 minutos (possível travamento)
SELECT id, erp_name, created_at, attempt_count
FROM outbox
WHERE status = 'pendente'
  AND created_at < now() - interval '30 minutes'
ORDER BY created_at;

-- Records com falha permanente nas últimas 24h
SELECT id, erp_name, last_error, updated_at
FROM outbox
WHERE status = 'falhou'
  AND updated_at > now() - interval '24 hours'
ORDER BY updated_at DESC;

-- Taxa de sucesso por ERP (últimas 24h)
SELECT erp_name,
       count(*) FILTER (WHERE status = 'enviado') AS enviados,
       count(*) FILTER (WHERE status = 'falhou')  AS falhos,
       count(*) FILTER (WHERE status = 'pendente') AS pendentes
FROM outbox
WHERE created_at > now() - interval '24 hours'
GROUP BY erp_name;

-- Últimas entradas do audit log para um correlationId
SELECT timestamp, action, component, details
FROM audit_log
WHERE correlation_id = '<uuid>'
ORDER BY timestamp;
```

## Graceful Shutdown

O serviço responde a `SIGTERM` e `SIGINT`:

1. **Hard-exit timer** registrado (10s) como garantia
2. Cron jobs parados (sem novos ciclos)
3. Requisições HTTP em andamento canceladas via `AbortSignal`
4. Pool PostgreSQL fechado
5. Processo encerra com código 0

Em caso de travamento no shutdown, o processo é forçado após 10 segundos com código 1.

## Rotação de Token Ávimus

Se o token `AVIMUS_API_TOKEN` for rotacionado, reiniciar o serviço é suficiente (o cliente Axios é recriado no startup). Para rotação sem downtime, chamar `resetAvimusClient()` e reiniciar o processo.

## Dead-Letter (falhou)

Records com `status = 'falhou'` requerem intervenção manual:

1. Investigar `last_error` e `audit_log` com o `correlation_id`
2. Corrigir a causa raiz (ex: step inativo no Ávimus, paciente não encontrado)
3. Re-enfileirar se necessário:

```sql
UPDATE outbox
SET status = 'pendente', attempt_count = 0, last_error = NULL, updated_at = now()
WHERE id = '<uuid>';
```
