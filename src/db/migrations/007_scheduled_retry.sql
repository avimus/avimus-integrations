-- Retry automático agendado entre ticks do cron de entrega (ver ADR-004).
-- Falhas transitórias voltam para a fila com next_retry_at no futuro
-- (backoff 1min → 5min → 15min → 1h → 6h); o claim só pega registros cujo
-- horário chegou. max_attempts passa a valer de verdade: 6 tentativas de
-- entrega no total (1 inicial + 5 reagendadas).

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE outbox ALTER COLUMN max_attempts SET DEFAULT 6;

-- Registros existentes ainda no default antigo ganham o teto novo
UPDATE outbox SET max_attempts = 6 WHERE max_attempts = 3;
