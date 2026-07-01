function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Alguns ERPs devolvem a lista de registros dentro de uma chave do objeto de
// resposta (ex.: `{ atendimentos: [...], data_consulta: "..." }`), não como
// array puro na raiz. Esta função normaliza os dois formatos, procurando a
// primeira propriedade cujo valor seja um array não-vazio de objetos.
// Usada tanto pela introspecção de campos quanto pela busca real de eventos
// (ver field-introspector.ts e adapters/tasy/index.ts) para que as duas nunca
// divirjam sobre "onde estão os registros" na resposta do ERP.
export function unwrapRecordArray(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    return data.every(isRecord) ? (data as Record<string, unknown>[]) : null;
  }
  if (isRecord(data)) {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
        return value as Record<string, unknown>[];
      }
    }
  }
  return null;
}
