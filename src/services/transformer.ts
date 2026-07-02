import type { RawErpRecord } from '../adapters/types.js';
import type { TenantErpContext } from './types.js';
import { findMatchingStep, type MatchResult } from './matcher.js';
import { resolveProtocol } from '../clients/avimus.js';
import { logger, safeLog } from '../lib/logger.js';
import type { CompleteStepPayload } from '../clients/avimus.js';

export interface CompleteStepTransformResult {
  action: 'complete_step';
  match: MatchResult;
  payload: CompleteStepPayload;
}

export interface StartJourneyTransformResult {
  action: 'start_journey';
  cpf: string;
  protocolId: string; // código bruto do ERP — resolvido para UUID interno na entrega
  erpName: string;
  // Campos opcionais para cadastrar o paciente se ele ainda não existir na
  // Ávimus — mapeados via field_mappings (ex.: FULLNAME → patientName).
  patientName?: string;
  patientBirthDate?: string;
  patientPhone?: string;
  patientEmail?: string;
}

export type TransformResult = CompleteStepTransformResult | StartJourneyTransformResult;

function extractMappedFields(
  rawPayload: Record<string, unknown>,
  context: TenantErpContext,
): Record<string, unknown> {
  const tenantId = context.tenant.id;
  const endpointId = context.endpoint.id;
  const mapped: Record<string, unknown> = {};

  for (const mapping of context.fieldMappings) {
    const value = rawPayload[mapping.source_field];
    if (value === undefined) {
      logger.debug(
        { tenantId, endpointId, sourceField: mapping.source_field, targetField: mapping.target_field },
        'Source field absent from ERP payload',
      );
    } else {
      mapped[mapping.target_field] = value;
    }
  }

  return mapped;
}

export async function transformEvent(
  rawRecord: RawErpRecord,
  context: TenantErpContext,
): Promise<TransformResult | null> {
  const tenantId = context.tenant.id;
  const endpointId = context.endpoint.id;

  // Step 1: Extract all configured field mappings from the raw ERP payload
  const mappedFields = extractMappedFields(rawRecord.rawPayload, context);

  // Step 2: Validate cpf (mandatory for all actions)
  const cpfRaw = mappedFields['cpf'];
  const cpf = cpfRaw != null ? String(cpfRaw).trim() : '';
  if (!cpf) {
    logger.warn(
      safeLog({ tenantId, endpointId, eventId: rawRecord.eventId, cpf: mappedFields['cpf'] }),
      'Missing or empty cpf field — skipping record',
    );
    return null;
  }

  // Step 3: Validate erpEventCode (needed to find event_mapping)
  const erpEventCode = typeof mappedFields['erpEventCode'] === 'string' ? mappedFields['erpEventCode'] : '';
  if (!erpEventCode) {
    logger.warn(
      { tenantId, endpointId, eventId: rawRecord.eventId },
      'Missing erpEventCode field — skipping record',
    );
    return null;
  }

  // Step 4: Resolve ERP event code → event_mapping (contains avimus_action)
  const eventMapping = context.eventMappings.find((m) => m.erp_event_code === erpEventCode);
  if (!eventMapping) {
    logger.warn(
      { tenantId, endpointId, erpEventCode },
      'No event_mapping found for ERP event code — skipping record',
    );
    return null;
  }

  // Step 5: Branch by avimus_action
  if (eventMapping.avimus_action === 'start_journey') {
    const protocolIdRaw = mappedFields['protocolId'];
    const protocolId = protocolIdRaw != null ? String(protocolIdRaw).trim() : '';
    if (!protocolId) {
      logger.warn(
        { tenantId, endpointId, eventId: rawRecord.eventId },
        'Missing protocolId field for start_journey action — skipping record',
      );
      return null;
    }
    const patientName = typeof mappedFields['patientName'] === 'string' ? mappedFields['patientName'] : undefined;
    const patientBirthDate = typeof mappedFields['patientBirthDate'] === 'string' ? mappedFields['patientBirthDate'] : undefined;
    const patientPhone = typeof mappedFields['patientPhone'] === 'string' ? mappedFields['patientPhone'] : undefined;
    const patientEmail = typeof mappedFields['patientEmail'] === 'string' ? mappedFields['patientEmail'] : undefined;

    return {
      action: 'start_journey',
      cpf,
      protocolId,
      erpName: context.connection.erp_name,
      patientName,
      patientBirthDate,
      patientPhone,
      patientEmail,
    };
  }

  // Default: complete_step
  // Validate eventDate (required for complete_step)
  const eventDateRaw = mappedFields['eventDate'];
  if (eventDateRaw === undefined || eventDateRaw === null || eventDateRaw === '') {
    logger.warn(
      { tenantId, endpointId, eventId: rawRecord.eventId },
      'Missing eventDate field — skipping record',
    );
    return null;
  }
  const eventDate = new Date(String(eventDateRaw));
  if (isNaN(eventDate.getTime())) {
    logger.warn(
      { tenantId, endpointId, eventId: rawRecord.eventId, eventDateRaw },
      'Invalid eventDate value — skipping record',
    );
    return null;
  }

  if (!eventMapping.avimus_event_id) {
    logger.warn(
      { tenantId, endpointId, erpEventCode },
      'complete_step event_mapping missing avimus_event_id — skipping record',
    );
    return null;
  }

  if (!context.avimusApiToken) {
    logger.warn(
      { tenantId, endpointId },
      'Tenant has no avimus_api_token configured — skipping record',
    );
    return null;
  }

  // protocolId opcional: se mapeado, resolve o código bruto do ERP (ex.:
  // CD_PROTOCOLO="283") no protocolo interno — mesmo de-para do start_journey
  // (ProtocolExternalCode) — para restringir o matching à jornada do
  // protocolo certo quando o paciente tem mais de uma ativa.
  let resolvedProtocolId: string | undefined;
  const rawProtocolCode = mappedFields['protocolId'] != null ? String(mappedFields['protocolId']).trim() : '';
  if (rawProtocolCode) {
    const protocol = await resolveProtocol(context.avimusApiToken, context.connection.erp_name, rawProtocolCode);
    if (!protocol) {
      logger.warn(
        { tenantId, endpointId, eventId: rawRecord.eventId, rawProtocolCode },
        'No protocol found for external code — cadastre o código externo no protocolo (skipping record)',
      );
      return null;
    }
    resolvedProtocolId = protocol.id;
  }

  // Find matching step via Ávimus API
  const match = await findMatchingStep(
    context.avimusApiToken,
    cpf,
    eventMapping.avimus_event_id,
    resolvedProtocolId,
  );
  if (!match) {
    logger.info(
      safeLog({ tenantId, endpointId, eventId: rawRecord.eventId, cpf, avimusEventId: eventMapping.avimus_event_id }),
      'No Ávimus match found — skipping record',
    );
    return null;
  }

  // Build complete_step outbox payload
  // protocolId excluído: o código bruto do ERP sobrescreveria (via spread) o
  // protocolId interno já colocado no metadata abaixo. result vira coluna
  // própria; cpf/erpEventCode/eventDate já têm destino dedicado.
  const extraMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mappedFields)) {
    if (!['cpf', 'erpEventCode', 'eventDate', 'protocolId', 'result', 'notes'].includes(key)) {
      extraMetadata[key] = value;
    }
  }

  // Observação legível, no mesmo espírito do que um humano digitaria no
  // drawer — inclui o profissional do ERP quando mapeado.
  const professionalName =
    typeof mappedFields['professionalName'] === 'string' ? mappedFields['professionalName'].trim() : '';
  const erpNotes = mappedFields['notes'] != null ? String(mappedFields['notes']).trim() : '';
  const eventDateBr = eventDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  // Limite do CompleteStepSchema na API (max 2000) — trunca a observação do
  // ERP se necessário em vez de falhar a entrega com 400.
  const notes = [
    `Concluído via integração ${context.connection.erp_name} — evento ${erpEventCode} em ${eventDateBr}`,
    ...(professionalName ? [`Profissional: ${professionalName}`] : []),
    ...(erpNotes ? [`Obs.: ${erpNotes}`] : []),
  ].join('. ').slice(0, 2000);

  // result só quando mapeado: 'completed' fixo não casava com as opções de
  // ramificação de etapas de decisão (422 UNMATCHED_BRANCH_RESULT) e sujava
  // a UI das etapas normais.
  const mappedResult = mappedFields['result'] != null ? String(mappedFields['result']).trim() : '';

  const payload: CompleteStepPayload = {
    ...(mappedResult ? { result: mappedResult } : {}),
    notes,
    executedAt: eventDate.toISOString(),
    metadata: {
      erpName: context.connection.erp_name,
      protocolId: match.protocol,
      ...extraMetadata,
    },
  };

  return { action: 'complete_step', match, payload };
}
