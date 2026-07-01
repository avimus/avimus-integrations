import * as avimus from '../clients/avimus.js';
import { logger, safeLog } from '../lib/logger.js';

export interface MatchResult {
  patientId: string;
  journeyId: string;
  stepId: string;
  protocol: string;
}

export async function matchPatient(token: string, cpf: string): Promise<avimus.AvimusPatient | null> {
  const patient = await avimus.searchPatient(token, cpf);
  if (!patient) {
    logger.info(safeLog({ cpf }), 'No patient found for CPF');
    return null;
  }
  return patient;
}

export async function matchJourney(token: string, patientId: string): Promise<avimus.AvimusJourney | null> {
  const journeys = await avimus.listJourneys(token, patientId);
  const active = journeys[0] ?? null;
  if (!active) {
    logger.info({ patientId }, 'No active journey found for patient');
    return null;
  }
  return active;
}

// Retorna o step + o protocolId da jornada (só disponível no detalhe, não
// na listagem) juntos, já que ambos vêm da mesma chamada.
export async function matchStep(
  token: string,
  journeyId: string,
  avimusEventId: string,
): Promise<{ step: avimus.AvimusStep; protocolId: string } | null> {
  const detail = await avimus.getJourneyDetail(token, journeyId);
  const matching = detail.steps.find((s) => s.integrationEvent?.id === avimusEventId);
  if (!matching) {
    logger.info({ journeyId, avimusEventId }, 'No matching step found for event');
    return null;
  }
  return { step: matching, protocolId: detail.protocolId };
}

export async function findMatchingStep(
  token: string,
  cpf: string,
  avimusEventId: string,
): Promise<MatchResult | null> {
  const patient = await matchPatient(token, cpf);
  if (!patient) return null;

  const journey = await matchJourney(token, patient.id);
  if (!journey) return null;

  const match = await matchStep(token, journey.id, avimusEventId);
  if (!match) return null;

  return {
    patientId: patient.id,
    journeyId: journey.id,
    stepId: match.step.id,
    protocol: match.protocolId,
  };
}
