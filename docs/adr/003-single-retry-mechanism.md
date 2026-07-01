# ADR-003: withRetry como Único Mecanismo de Retry

**Status**: Aceito  
**Data**: 2026-06-29

## Contexto

A implementação original tinha dois sistemas de retry independentes:
1. `withRetry({ maxAttempts: 3 })` — retry interno por run do outbox-worker
2. `attempt_count < max_attempts` — re-claim do record nas próximas ticks do cron

Isso resultava em até 9 tentativas HTTP (3×3) violando FR-006 ("retry up to 3 times").

## Decisão

`withRetry` é o **único** mecanismo de retry. Configurado com `maxAttempts = config.maxRetries` (env `MAX_RETRIES`, padrão 3).

- **Sucesso**: `markSent()`
- **Falha após todos os retries**: `markFailed()` diretamente
- **Falha permanente (404/401/403)**: `markFailed()` imediatamente sem retry

As colunas `attempt_count` e `max_attempts` na tabela `outbox` tornam-se informacionais (rastreiam tentativas internas via `onRetry`).

## Consequências

**Positivas**:
- Comportamento previsível: exatamente `MAX_RETRIES` tentativas HTTP totais
- Exponential backoff com jitter ativo (dentro do mesmo run, não entre crons)
- `MAX_RETRIES` env var agora tem efeito real

**Negativas**:
- Sem retry entre cron ticks — um record que falha em todas as tentativas é marcado `falhou` definitivamente e requer intervenção manual
- Backoff máximo limitado a `capMs = 10s` (dentro de um único run), não a minutos entre crons

## Alternativas Consideradas

- **Manter outer loop, remover withRetry**: Um retry por tick de cron (a cada minuto). Mais simples mas sem backoff intra-run e mais lento para recuperar de falhas transitórias curtas.
