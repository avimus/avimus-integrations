// Um endpoint com pelo menos um event_mapping de complete_step precisa ter
// cpf e erpEventCode mapeados em field_mappings — são os dois campos
// universais que transformer.ts exige pra sequer tentar casar o evento
// (ver findMatchingStep em matcher.ts). Sem essa checagem, a falta só
// aparece em runtime, registro por registro, descartada em silêncio.
export class MissingCompleteStepFieldsError extends Error {
  statusCode = 422;

  constructor(public missingFields: string[]) {
    super(
      `Endpoint tem ação complete_step ativa, mas falta mapear: ${missingFields.join(', ')}`,
    );
  }
}

const REQUIRED_COMPLETE_STEP_FIELDS = ['cpf', 'erpEventCode'];

export function assertCompleteStepFieldsPresent(
  fieldMappings: { target_field: string }[],
  eventMappings: { avimus_action: string }[],
): void {
  const hasCompleteStep = eventMappings.some((m) => m.avimus_action === 'complete_step');
  if (!hasCompleteStep) return;

  const targetFields = new Set(fieldMappings.map((f) => f.target_field));
  const missingFields = REQUIRED_COMPLETE_STEP_FIELDS.filter((f) => !targetFields.has(f));
  if (missingFields.length > 0) {
    throw new MissingCompleteStepFieldsError(missingFields);
  }
}
