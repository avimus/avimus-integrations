import type { Pool } from 'pg';
import axios from 'axios';
import type { OutboxRecord } from '../../db/queries/outbox.js';
import { markSent } from '../../db/queries/outbox.js';
import { getTenantAvimusToken } from '../../db/queries/tenants.js';
import { logAudit } from '../../db/queries/audit-log.js';
import { checkActiveJourney, startJourney, searchPatient, createPatient, resolveProtocol } from '../../clients/avimus.js';
import { logger, safeLog } from '../../lib/logger.js';

export async function startJourneyAction(
  pool: Pool,
  record: OutboxRecord,
  signal?: AbortSignal,
): Promise<void> {
  const payload = record.payload as {
    cpf?: string;
    protocolId?: string; // código bruto do ERP, ainda não resolvido
    erpName?: string;
    patientName?: string;
    patientBirthDate?: string;
    patientPhone?: string;
    patientEmail?: string;
  };
  const { cpf, protocolId: rawProtocolId, erpName } = payload;

  if (!cpf || !rawProtocolId || !erpName) {
    throw new Error('start_journey payload missing cpf, protocolId or erpName');
  }

  const token = await getTenantAvimusToken(pool, record.tenant_id ?? '');
  if (!token) {
    throw new Error(`Tenant ${record.tenant_id ?? '(none)'} has no avimus_api_token configured`);
  }

  // 1. Resolve o código bruto do ERP (ex.: CD_PROTOCOLO="283") no protocolo
  //    interno via ProtocolExternalCode (ver GET /api/v1/protocols/resolve).
  const protocol = await resolveProtocol(token, erpName, rawProtocolId);
  if (!protocol) {
    throw new Error(
      `No protocol found for external code "${rawProtocolId}" (erp: ${erpName}) — cadastre o código externo no protocolo antes de reprocessar`,
    );
  }

  // 2. Acha o paciente por CPF; cria se ainda não existir (dados vêm do
  //    field_mappings do endpoint — patientName/patientBirthDate são
  //    obrigatórios para criar; se faltarem e o paciente não existir, falha
  //    com mensagem clara em vez de tentar com dados incompletos).
  let patient = await searchPatient(token, cpf);
  if (!patient) {
    if (!payload.patientName || !payload.patientBirthDate) {
      throw new Error(
        'Patient not found and payload is missing patientName/patientBirthDate to create one — map these fields in the endpoint field-mappings',
      );
    }
    patient = await createPatient(token, {
      cpf,
      fullName: payload.patientName,
      birthDate: payload.patientBirthDate,
      contactPhone: payload.patientPhone,
      contactEmail: payload.patientEmail,
    });
    logger.info(safeLog({ outboxId: record.id, cpf }), 'Created new patient for start_journey');
  }

  // 3. Idempotency check: skip if journey already exists
  const existing = await checkActiveJourney(token, patient.id, protocol.id);
  if (existing) {
    await markSent(pool, record.id);
    logger.info(
      safeLog({ outboxId: record.id, protocolId: protocol.id }),
      'Skipping start_journey — active journey already exists',
    );
    await logAudit(pool, {
      tenantId: record.tenant_id ?? undefined,
      action: 'delivery.skipped_duplicate',
      component: 'outbox-worker',
      recordType: 'outbox',
      recordId: record.id,
      erpName: record.erp_name,
      correlationId: record.correlation_id,
      details: { protocolId: protocol.id, journeyId: existing.id },
    });
    return;
  }

  // Segunda camada de idempotência: mesmo com o check acima, uma corrida
  // entre dois ciclos (ou um bug futuro no check) pode chegar aqui com a
  // jornada já existindo — a API real já impede duplicidade nesse caso
  // (409 DUPLICATE_ACTIVE_JOURNEY), então tratamos como sucesso silencioso
  // em vez de falha a ser reprocessada indefinidamente.
  let journey: { id: string };
  try {
    journey = await startJourney(token, patient.id, protocol.id, signal);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      const active = await checkActiveJourney(token, patient.id, protocol.id);
      if (active) {
        await markSent(pool, record.id);
        logger.info(
          safeLog({ outboxId: record.id, protocolId: protocol.id }),
          'start_journey retornou 409 mas jornada já existe — marcando como entregue',
        );
        return;
      }
    }
    throw err;
  }

  await Promise.all([
    markSent(pool, record.id),
    logAudit(pool, {
      tenantId: record.tenant_id ?? undefined,
      action: 'delivery.success',
      component: 'outbox-worker',
      recordType: 'outbox',
      recordId: record.id,
      erpName: record.erp_name,
      correlationId: record.correlation_id,
      details: { protocolId: protocol.id, journeyId: journey.id },
    }),
  ]);
}
