import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { OutboxRecord } from '../../../src/db/queries/outbox.js';

// Retry agendado (ADR-004): falha transitória reagenda com backoff;
// falha permanente e esgotamento de tentativas marcam 'falhou'.

const claimPending = vi.fn();
const markFailed = vi.fn();
const scheduleRetry = vi.fn();
const logAudit = vi.fn();
const handler = vi.fn();

vi.mock('../../../src/db/queries/outbox.js', () => ({
  claimPending: (...args: unknown[]) => claimPending(...args),
  markFailed: (...args: unknown[]) => markFailed(...args),
  scheduleRetry: (...args: unknown[]) => scheduleRetry(...args),
}));
vi.mock('../../../src/db/queries/audit-log.js', () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
}));
vi.mock('../../../src/services/avimus-actions/index.js', () => ({
  ACTION_HANDLERS: {
    start_journey: (...args: unknown[]) => handler(...args),
  },
}));

const { processPendingDeliveries } = await import('../../../src/services/outbox-worker.js');

const pool = {} as Pool;

function makeRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: 'rec-1',
    aggregate_type: 'patient_journey',
    aggregate_id: '12345678901',
    event_type: 'start_protocolo',
    payload: { avimus_action: 'start_journey' },
    status: 'pendente',
    attempt_count: 0,
    max_attempts: 6,
    last_error: null,
    correlation_id: 'corr-1',
    erp_name: 'tasy',
    tenant_id: 'tenant-1',
    next_retry_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function axios503(): Error {
  return Object.assign(new Error('Request failed with status code 503'), {
    response: { status: 503 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processPendingDeliveries — retry agendado', () => {
  it('erro transitório na 1ª tentativa agenda retry em ~1min', async () => {
    claimPending.mockResolvedValue([makeRecord()]);
    handler.mockRejectedValue(axios503());

    const before = Date.now();
    const result = await processPendingDeliveries(pool);

    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(scheduleRetry).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();

    const nextRetryAt = scheduleRetry.mock.calls[0][4] as Date;
    const delay = nextRetryAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(55_000);
    expect(delay).toBeLessThanOrEqual(65_000);
  });

  it('erro transitório na 3ª tentativa usa o delay da posição certa (15min)', async () => {
    claimPending.mockResolvedValue([makeRecord({ attempt_count: 2 })]);
    handler.mockRejectedValue(axios503());

    const before = Date.now();
    await processPendingDeliveries(pool);

    const nextRetryAt = scheduleRetry.mock.calls[0][4] as Date;
    const delay = nextRetryAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(890_000);
    expect(delay).toBeLessThanOrEqual(910_000);
  });

  it('erro permanente (404) vai direto para falhou, sem reagendar', async () => {
    claimPending.mockResolvedValue([makeRecord()]);
    handler.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }),
    );

    await processPendingDeliveries(pool);

    expect(markFailed).toHaveBeenCalledOnce();
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('erro de validação (Error simples) é permanente', async () => {
    claimPending.mockResolvedValue([makeRecord()]);
    handler.mockRejectedValue(new Error('start_journey payload missing cpf, protocolId or erpName'));

    await processPendingDeliveries(pool);

    expect(markFailed).toHaveBeenCalledOnce();
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('esgotou max_attempts: transitório vira falhou definitivo', async () => {
    claimPending.mockResolvedValue([makeRecord({ attempt_count: 5, max_attempts: 6 })]);
    handler.mockRejectedValue(axios503());

    await processPendingDeliveries(pool);

    expect(markFailed).toHaveBeenCalledOnce();
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('sucesso não toca em retry nem falha', async () => {
    claimPending.mockResolvedValue([makeRecord()]);
    handler.mockResolvedValue(undefined);

    const result = await processPendingDeliveries(pool);

    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(markFailed).not.toHaveBeenCalled();
    expect(scheduleRetry).not.toHaveBeenCalled();
  });
});
