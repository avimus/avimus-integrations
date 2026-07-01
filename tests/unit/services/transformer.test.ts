import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock matcher so transformer tests don't hit the network
vi.mock('../../../src/services/matcher.js', () => ({
  findMatchingStep: vi.fn(),
}));

import { transformEvent } from '../../../src/services/transformer.js';
import { findMatchingStep } from '../../../src/services/matcher.js';
import type { RawEvent } from '../../../src/adapters/types.js';

const mockMatch = {
  patientId: 'patient-1',
  journeyId: 'journey-1',
  stepId: 'step-1',
  protocol: 'PROTO-001',
};

const baseEvent: RawEvent = {
  eventId: 'tasy-12345',
  cpf: '12345678901',
  erpEventCode: 'CONSULTA_REALIZADA',
  eventDate: new Date('2026-06-29T10:00:00Z'),
  payload: { erpName: 'tasy' },
};

beforeEach(() => {
  vi.mocked(findMatchingStep).mockReset();
});

describe('transformEvent', () => {
  it('returns null and warns when CPF is empty', async () => {
    const result = await transformEvent({ ...baseEvent, cpf: '' });
    expect(result).toBeNull();
    expect(findMatchingStep).not.toHaveBeenCalled();
  });

  it('returns null and warns when CPF is whitespace-only', async () => {
    const result = await transformEvent({ ...baseEvent, cpf: '   ' });
    expect(result).toBeNull();
  });

  it('returns null when no match found', async () => {
    vi.mocked(findMatchingStep).mockResolvedValue(null);
    const result = await transformEvent(baseEvent);
    expect(result).toBeNull();
  });

  it('returns transformed payload when match found', async () => {
    vi.mocked(findMatchingStep).mockResolvedValue(mockMatch);
    const result = await transformEvent(baseEvent);
    expect(result).not.toBeNull();
    expect(result!.match.stepId).toBe('step-1');
    expect(result!.match.patientId).toBe('patient-1');
    expect(result!.payload.result).toBe('completed');
    expect(result!.payload.metadata.erpName).toBe('tasy');
    expect(result!.payload.metadata.protocolId).toBe('PROTO-001');
    expect(result!.payload.metadata.eventDate).toBe('2026-06-29T10:00:00.000Z');
  });

  it('passes CPF and erpEventCode to matcher', async () => {
    vi.mocked(findMatchingStep).mockResolvedValue(mockMatch);
    await transformEvent(baseEvent);
    expect(findMatchingStep).toHaveBeenCalledWith('12345678901', 'CONSULTA_REALIZADA');
  });
});
