import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchJourney, findMatchingStep } from '../../../src/services/matcher.js';
import * as avimus from '../../../src/clients/avimus.js';

vi.mock('../../../src/clients/avimus.js');

const journey = (id: string) => ({ id, patientId: 'p1', protocolName: 'Proto', status: 'ativo' });

describe('matchJourney', () => {
  beforeEach(() => vi.resetAllMocks());

  it('passes protocolId through to listJourneys', async () => {
    vi.mocked(avimus.listJourneys).mockResolvedValue([journey('j1')]);
    const result = await matchJourney('tok', 'p1', 'proto-colica-a');
    expect(avimus.listJourneys).toHaveBeenCalledWith('tok', 'p1', 'proto-colica-a');
    expect(result?.id).toBe('j1');
  });

  it('returns null when no active journey matches the protocol', async () => {
    vi.mocked(avimus.listJourneys).mockResolvedValue([]);
    expect(await matchJourney('tok', 'p1', 'proto-hiper-a')).toBeNull();
  });

  it('still picks the first journey when protocolId is omitted (legacy behavior)', async () => {
    vi.mocked(avimus.listJourneys).mockResolvedValue([journey('j1'), journey('j2')]);
    const result = await matchJourney('tok', 'p1');
    expect(avimus.listJourneys).toHaveBeenCalledWith('tok', 'p1', undefined);
    expect(result?.id).toBe('j1');
  });
});

describe('findMatchingStep', () => {
  beforeEach(() => vi.resetAllMocks());

  it('threads protocolId down to the journey lookup', async () => {
    vi.mocked(avimus.searchPatient).mockResolvedValue({ id: 'p1', cpf: 'x', fullName: 'X' });
    vi.mocked(avimus.listJourneys).mockResolvedValue([journey('j1')]);
    vi.mocked(avimus.getJourneyDetail).mockResolvedValue({
      id: 'j1',
      patientId: 'p1',
      protocolId: 'proto-colica-a',
      protocolName: 'Proto',
      status: 'ativo',
      steps: [
        {
          id: 'step-1',
          protocolStepId: 'ps-1',
          status: 'pendente',
          integrationEvent: { id: 'evt-alta', name: 'Alta', erp: 'tasy', erpEventCode: 'alta_hospitalar' },
        },
      ],
    });

    const match = await findMatchingStep('tok', '12345678900', 'evt-alta', 'proto-colica-a');
    expect(avimus.listJourneys).toHaveBeenCalledWith('tok', 'p1', 'proto-colica-a');
    expect(match).toEqual({ patientId: 'p1', journeyId: 'j1', stepId: 'step-1', protocol: 'proto-colica-a' });
  });
});
