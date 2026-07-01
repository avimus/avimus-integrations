# Segurança & LGPD — Avimus Integrations

## Conformidade LGPD

Este serviço processa dados pessoais sensíveis de saúde (CPF, identificadores de pacientes). Os controles abaixo implementam os requisitos da LGPD para tratamento, armazenamento e acesso a esses dados.

## Criptografia em Repouso (FR-014)

### Implementação

O CPF do paciente (`aggregate_id` na tabela `outbox`) é criptografado antes de ser gravado no banco usando **AES-256-GCM com IV determinístico**.

**Arquivo**: `src/lib/crypto.ts`

```
Plaintext CPF → encrypt(cpf, ENCRYPTION_KEY) → base64(IV || AuthTag || Ciphertext)
```

**Propriedades**:
- IV derivado de `HMAC-SHA256(key, plaintext)` — determinístico para permitir queries de igualdade (`WHERE aggregate_id = $1`)
- AuthTag de 128 bits detecta adulteração (autenticidade)
- Chave de 256 bits via env var `ENCRYPTION_KEY`

### O que está criptografado

| Campo | Tabela | Criptografado? |
|-------|--------|---------------|
| `aggregate_id` (CPF) | `outbox` | ✅ AES-256-GCM |
| `details` (JSONB) | `audit_log` | 🔶 Mascarado (não criptografado) |
| `payload` (JSONB) | `outbox` | ❌ Não contém CPF direto |

> O `audit_log.details` recebe mascaramento de CPF via `safeLog()` antes do INSERT. CPFs nunca aparecem completos nessa tabela.

### Gestão de Chave

- A chave deve ter **64 caracteres hexadecimais** (256 bits)
- Armazenar no secrets manager da infraestrutura (AWS Secrets Manager, Vault, etc.)
- **Nunca commitar** no repositório ou no `.env` de produção
- Rotação de chave requer re-criptografia dos registros existentes (operação de manutenção manual)

## Mascaramento em Logs (FR-015)

CPF **nunca aparece completo** em nenhum log. Dois mecanismos complementares:

### 1. Pino Redact (campo-a-campo)

```typescript
redact: {
  paths: ['*.cpf', '*.documento', '*.password', '*.token', '*.apiToken'],
  censor: '***REDACTED***',
}
```

### 2. `safeLog()` — Mascaramento por Regex + Campo

```typescript
// Campos com nome cpf/documento → ***REDACTED***
// Strings contendo padrão CPF → ***.456.789-**
safeLog({ cpf: '123.456.789-09' }) // → { cpf: '***REDACTED***' }
safeLog({ msg: 'paciente 12345678901' }) // → { msg: 'paciente ***.456.789-**' }
```

### Cobertura de Mascaramento

| Destino | Mecanismo |
|---------|-----------|
| Logs da aplicação (pino) | `pino.redact` + `safeLog()` |
| `audit_log.details` | `safeLog()` em `logAudit()` |
| Logs de erro de retry | `safeLog()` em `outbox-worker` |

## Trilha de Auditoria (FR-016)

Toda operação de acesso e modificação de dados é registrada na tabela `audit_log`:

```sql
CREATE TABLE audit_log (
    id             BIGSERIAL PRIMARY KEY,
    timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
    action         TEXT NOT NULL,        -- o que foi feito
    component      TEXT NOT NULL,        -- qual componente
    record_type    TEXT,                 -- tipo do registro afetado
    record_id      TEXT,                 -- ID do registro
    erp_name       TEXT,                 -- qual ERP
    details        JSONB,               -- contexto (CPF mascarado)
    correlation_id UUID                  -- rastreia a operação ponta-a-ponta
);
```

A tabela é **append-only** — nenhum dado é deletado ou atualizado.

## Autenticação

| Sistema | Método |
|---------|--------|
| Ávimus API | Bearer token via `Authorization: Bearer {AVIMUS_API_TOKEN}` |
| PostgreSQL | Connection string com credenciais via `DATABASE_URL` |
| Tasy API | Configurável por adapter (padrão: rede privada/VPN) |

## Superfície de Ataque

**O serviço NÃO expõe**:
- Endpoints HTTP (FR-010: sem web server)
- Portas abertas externas
- Interface administrativa

**Vetores de risco**:
- Comprometimento da `ENCRYPTION_KEY` → dados em repouso expostos
- Comprometimento do `AVIMUS_API_TOKEN` → acesso à API Ávimus
- Acesso direto ao PostgreSQL → CPFs criptografados, demais dados em plaintext

## Checklist de Segurança para Deploy

- [ ] `ENCRYPTION_KEY` gerado com `crypto.randomBytes(32).toString('hex')`
- [ ] `ENCRYPTION_KEY` armazenado em secrets manager (não em `.env` de produção)
- [ ] `AVIMUS_API_TOKEN` com escopo mínimo necessário
- [ ] `DATABASE_URL` com usuário PostgreSQL com permissões mínimas (SELECT/INSERT/UPDATE nas tabelas do serviço)
- [ ] Tasy API acessível apenas via rede privada ou VPN
- [ ] Logs não persistidos em sistema sem controle de acesso
- [ ] Rotação periódica dos tokens documentada no runbook
