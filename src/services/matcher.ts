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

// protocolId (interno, já resolvido) restringe a busca à jornada do protocolo
// certo — sem ele, um paciente com duas jornadas ativas em paralelo pegaria a
// primeira que a API devolvesse, possivelmente do protocolo errado.
export async function matchJourney(
  token: string,
  patientId: string,
  protocolId?: string,
): Promise<avimus.AvimusJourney | null> {
  const journeys = await avimus.listJourneys(token, patientId, protocolId);
  const active = journeys[0] ?? null;
  if (!active) {
    logger.info({ patientId, protocolId }, 'No active journey found for patient');
    return null;
  }
  if (journeys.length > 1) {
    logger.warn(
      { patientId, protocolId, journeyIds: journeys.map((j) => j.id) },
      'Multiple active journeys matched — using the first; map a protocolId field on the endpoint to disambiguate',
    );
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
  protocolId?: string,
): Promise<MatchResult | null> {
  const patient = await matchPatient(token, cpf);
  if (!patient) return null;

  const journey = await matchJourney(token, patient.id, protocolId);
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
