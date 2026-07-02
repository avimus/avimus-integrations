import axios, { type AxiosInstance } from 'axios';
import { getConfig } from '../config/index.js';

export interface AvimusPatient {
  id: string;
  cpf: string;
  fullName: string;
}

// Shape de GET /journeys (listagem) — não inclui protocolId nem o `id` real
// do journey_step (só protocolStepId), apenas um resumo. Para essas
// informações é preciso GET /journeys/:id (ver AvimusJourneyDetail).
export interface AvimusJourney {
  id: string;
  patientId: string;
  protocolName: string;
  status: string;
}

// Shape de um step dentro de GET /journeys/:id — `id` aqui é o journey_step
// real (o que PATCH /steps/:id/complete espera), diferente de
// `protocolStepId` (referência à definição do step no protocolo).
export interface AvimusStep {
  id: string;
  protocolStepId: string;
  status: string;
  integrationEvent: { id: string; name: string; erp: string; erpEventCode: string } | null;
}

export interface AvimusJourneyDetail {
  id: string;
  patientId: string;
  protocolId: string;
  protocolName: string;
  status: string;
  steps: AvimusStep[];
}

export interface CreatePatientInput {
  cpf: string;
  fullName: string;
  birthDate: string; // ISO datetime string
  contactPhone?: string;
  contactEmail?: string;
  lgpdLegalBasis?: string;
}

export interface AvimusProtocol {
  id: string;
  name: string;
}

export interface CompleteStepPayload {
  result: string;
  notes: string;
  metadata: {
    erpName: string;
    protocolId: string;
    eventDate: string;
    [key: string]: unknown; // additional mapped fields from field_mappings
  };
}

// Um cliente por tenant (por token) — cada tenant do worker autentica com
// seu próprio JWT de um usuário do patient-journey daquele tenant
// específico (ver db/queries/tenants.ts, avimus_api_token). A URL base
// continua global (mesmo deployment do patient-journey para todos os
// tenants); só a credencial é por tenant.
const clientsByToken = new Map<string, AxiosInstance>();

function getAvimusClient(token: string): AxiosInstance {
  const cached = clientsByToken.get(token);
  if (cached) return cached;

  const config = getConfig();
  const client = axios.create({
    baseURL: config.avimusApiUrl,
    timeout: 10_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  clientsByToken.set(token, client);
  return client;
}

// GET /api/v1/patients não suporta filtro por cpf (só `search`, paginado) —
// usa o endpoint de lookup exato dedicado, que retorna um único paciente ou
// 404 (ver GET /patients/lookup em apps/api/src/routes/patients.ts). A
// versão anterior chamava /patients?cpf=... e recebia a lista paginada
// inteira de volta, quebrando a checagem de existência do paciente.
export async function searchPatient(token: string, cpf: string): Promise<AvimusPatient | null> {
  const client = getAvimusClient(token);
  try {
    const { data } = await client.get<AvimusPatient>('/api/v1/patients/lookup', {
      params: { cpf },
    });
    return data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function createPatient(token: string, input: CreatePatientInput): Promise<AvimusPatient> {
  const client = getAvimusClient(token);
  const { data } = await client.post<AvimusPatient>('/api/v1/patients', input);
  return data;
}

// Converte um código de protocolo do ERP (ex.: CD_PROTOCOLO="283" no Tasy)
// no protocolo interno do Ávimus, via ProtocolExternalCode (ver
// packages/types/src/protocol.ts no patient-journey).
export async function resolveProtocol(
  token: string,
  erpName: string,
  externalCode: string,
): Promise<AvimusProtocol | null> {
  const client = getAvimusClient(token);
  try {
    const { data } = await client.get<AvimusProtocol>('/api/v1/protocols/resolve', {
      params: { erpName, externalCode },
    });
    return data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

export async function listJourneys(
  token: string,
  patientId: string,
  protocolId?: string,
): Promise<AvimusJourney[]> {
  const client = getAvimusClient(token);
  try {
    const { data } = await client.get<{ data: AvimusJourney[] }>('/api/v1/journeys', {
      params: { patientId, status: 'ativo', ...(protocolId ? { protocolId } : {}) },
    });
    return data.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return [];
    }
    throw err;
  }
}

// Não existe GET /journeys/:id/steps na API real — os steps (com o id real
// do journey_step, necessário para completar) só vêm embutidos no detalhe
// da jornada. A versão anterior chamava uma rota inexistente (404 sempre).
export async function getJourneyDetail(token: string, journeyId: string): Promise<AvimusJourneyDetail> {
  const client = getAvimusClient(token);
  const { data } = await client.get<AvimusJourneyDetail>(`/api/v1/journeys/${journeyId}`);
  return data;
}

// Resposta real vem envolvida em `completedStep` (junto com
// unlockedStepIds/nextStepId/progress) — não é um objeto {id, status} solto.
// Não usado hoje (completeStepAction descarta o retorno), mas corrigido para
// não deixar outra armadilha de tipo igual às que já encontramos aqui.
export async function completeStep(
  token: string,
  stepId: string,
  payload: CompleteStepPayload,
  signal?: AbortSignal,
): Promise<{ completedStep: { id: string; status: string } }> {
  const client = getAvimusClient(token);
  const { data } = await client.patch<{ completedStep: { id: string; status: string } }>(
    `/api/v1/steps/${stepId}/complete`,
    payload,
    { signal },
  );
  return data;
}

// Nota: GET /api/v1/journeys só filtra por patientId/protocolId/status — não
// existe filtro por cpf na API real (confirmado em apps/api/src/routes/journeys.ts
// do patient-journey). A versão anterior desta função enviava `cpf` como
// query param, que era silenciosamente ignorado pela API — bug corrigido
// junto com esta mudança.
//
// Também corrigido: a resposta real é sempre paginada (`{data, total, page,
// limit}`), nunca um array cru — a versão anterior fazia `Array.isArray(data)`
// nesse objeto (sempre falso) e retornava null mesmo com jornada ativa
// existente, quebrando a checagem de idempotência do start_journey.
export async function checkActiveJourney(
  token: string,
  patientId: string,
  protocolId: string,
): Promise<AvimusJourney | null> {
  const client = getAvimusClient(token);
  try {
    const { data } = await client.get<{ data: AvimusJourney[] }>('/api/v1/journeys', {
      params: { patientId, protocolId, status: 'ativo' },
    });
    return data.data[0] ?? null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

export async function startJourney(
  token: string,
  patientId: string,
  protocolId: string,
  signal?: AbortSignal,
): Promise<AvimusJourney> {
  const client = getAvimusClient(token);
  const { data } = await client.post<AvimusJourney>(
    '/api/v1/journeys',
    { patientId, protocolId },
    { signal },
  );
  return data;
}
