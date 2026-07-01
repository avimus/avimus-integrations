# ADR-004: Retry Agendado entre Ticks do Cron

**Status**: Aceito
**Data**: 2026-07-01
**Complementa**: ADR-003

## Contexto

O ADR-003 fez do `withRetry` o único mecanismo de retry: até `MAX_RETRIES`
tentativas HTTP com backoff de no máximo ~10s, dentro do mesmo run. A
consequência negativa admitida: qualquer indisponibilidade da Ávimus maior
que essa janela marcava o registro como `falhou` definitivo, exigindo clique
manual em "Forçar retry" no admin. Na prática, a tela de falhas virava rotina
operacional para eventos que se resolveriam sozinhos.

## Decisão

Dois níveis de retry, com papéis distintos:

1. **Intra-run (`withRetry`, ADR-003)** — segue como está: recuperação em
   segundos para soluços curtos (blip de rede, restart rápido).
2. **Agendado (novo)** — quando a entrega falha com **erro transitório**
   (classificado por `isTransientError` em `backoff.ts`: 5xx, 408/425/429,
   ECONNREFUSED/ETIMEDOUT/ECONNABORTED etc.), o registro **permanece
   `pendente`** com `next_retry_at` no futuro. `claimPending` só pega
   registros cujo horário chegou. Backoff: **1min → 5min → 15min → 1h → 6h**.

- `max_attempts` (agora **6**: 1 tentativa inicial + 5 reagendadas) passa a
  valer de verdade — esgotou, vira `falhou` definitivo.
- **Erro permanente** (4xx de validação/auth/404, erro de configuração) vai
  **direto** para `falhou`, sem reagendamento — retentar não corrige
  mapeamento errado nem token inválido.
- "Forçar retry" manual continua existindo para registros `falhou`
  (zera `attempt_count` e `next_retry_at`).

## Consequências

**Positivas**:
- Indisponibilidades de até ~7h se curam sozinhas, sem intervenção.
- A tela de falhas do admin passa a listar só o que exige ação humana.
- Auditoria distingue `delivery.retry_scheduled` de `delivery.failed`
  (com `permanent: true/false`).

**Negativas**:
- Tentativas HTTP totais podem chegar a `MAX_RETRIES × max_attempts`
  (3×6 = 18) para um mesmo registro em indisponibilidade longa — aceitável,
  pois cada leva intra-run dura segundos e o espaçamento agendado domina.
- Registro "aguardando retry" continua com status `pendente` (sem status
  novo) — o admin diferencia por `attempt_count > 0` + `next_retry_at`.
