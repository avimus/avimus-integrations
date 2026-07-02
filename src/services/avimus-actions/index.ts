import type { Pool } from 'pg';
import type { OutboxRecord } from '../../db/queries/outbox.js';
import { completeStepAction } from './complete-step.js';
import { startJourneyAction } from './start-journey.js';

export type AvimusActionHandler = (
  pool: Pool,
  record: OutboxRecord,
  signal?: AbortSignal,
) => Promise<void>;

export const ACTION_HANDLERS: Record<string, AvimusActionHandler> = {
  complete_step: completeStepAction,
  start_journey: startJourneyAction,
};

export interface AvimusActionPayloadField {
  name: string;
  required: boolean;
  description: string;
}

export interface AvimusActionMetadata {
  action: string;
  label: string;
  method: string;
  path: string;
  requiresEventId: boolean;
  payloadFields: AvimusActionPayloadField[];
}

// Descreve, para cada chave em ACTION_HANDLERS, qual rota real da API do
// Ávimus Patient Journey ela chama, se ela exige avimus_event_id (ver
// validação equivalente em src/api/routes/erp-endpoint-event-mappings.ts), e
// quais campos — além de cpf/erpEventCode, sempre exigidos por qualquer ação
// (ver transformer.ts) — ela lê do payload mapeado. `payloadFields` é
// consumido pelo admin (via GET /avimus-actions) para sugerir campos de
// destino no mapeamento de campos, sem precisar hardcodar essa lista lá —
// adicionar/editar um campo aqui já é suficiente para ele aparecer sugerido.
export const ACTION_METADATA: Record<string, AvimusActionMetadata> = {
  complete_step: {
    action: 'complete_step',
    label: 'Completar step',
    method: 'PATCH',
    path: '/api/v1/steps/{stepId}/complete',
    requiresEventId: true,
    payloadFields: [
      { name: 'eventDate', required: true, description: 'Data/hora do evento no ERP (usada como data de execução do step)' },
      { name: 'protocolId', required: false, description: 'Código do protocolo no ERP (ex.: CD_PROTOCOLO no Tasy) — restringe o matching à jornada do protocolo certo quando o paciente tem mais de uma ativa; sem ele, a primeira jornada ativa é usada' },
      { name: 'professionalName', required: false, description: 'Nome do profissional que realizou o atendimento no ERP — entra na observação da etapa e nos dados da integração' },
      { name: 'result', required: false, description: 'Resultado da etapa — obrigatório para concluir etapas de decisão com ramificação (o valor precisa ser uma das opções configuradas no protocolo)' },
    ],
  },
  start_journey: {
    action: 'start_journey',
    label: 'Iniciar jornada',
    method: 'POST',
    path: '/api/v1/journeys',
    requiresEventId: false,
    payloadFields: [
      { name: 'protocolId', required: true, description: 'Código do protocolo no ERP (ex.: CD_PROTOCOLO no Tasy) — resolvido para o protocolo interno via códigos externos cadastrados' },
      { name: 'patientName', required: false, description: 'Nome completo do paciente — usado para cadastrá-lo automaticamente se ainda não existir na Ávimus' },
      { name: 'patientBirthDate', required: false, description: 'Data de nascimento do paciente — necessária junto com patientName para criar o paciente automaticamente' },
      { name: 'patientPhone', required: false, description: 'Telefone de contato do paciente (opcional, usado apenas no cadastro automático)' },
      { name: 'patientEmail', required: false, description: 'E-mail de contato do paciente (opcional, usado apenas no cadastro automático)' },
    ],
  },
};
