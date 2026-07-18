-- Registro de eventos do ERP que o transformEvent() descartou antes de
-- sequer virar linha no outbox (campo obrigatório faltando, sem
-- event_mapping, sem jornada ativa pro paciente, ou sem etapa correspondente
-- na jornada). Sem esta tabela, esses descartes nunca aparecem em lugar
-- nenhum — nem no outbox, nem na tela de falhas do admin.
CREATE TABLE dropped_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  erp_event_code TEXT,
  drop_reason TEXT NOT NULL CHECK (drop_reason IN ('missing_field', 'no_event_mapping', 'no_active_journey', 'no_matching_step')),
  cpf_masked TEXT,
  protocol_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX dropped_events_tenant_created_idx ON dropped_events (tenant_id, created_at DESC);
