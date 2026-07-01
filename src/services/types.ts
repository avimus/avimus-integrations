import type { ErpAdapter } from '../adapters/types.js';
import type { Tenant } from '../db/queries/tenants.js';
import type { ErpConnection } from '../db/queries/erp-connections.js';
import type { ErpEndpointWithCredentials } from '../db/queries/erp-endpoints.js';
import type { FieldMapping } from '../db/queries/field-mappings.js';
import type { EventMapping } from '../db/queries/event-mappings.js';

export interface TenantErpContext {
  tenant: Tenant;
  connection: ErpConnection;
  endpoint: ErpEndpointWithCredentials;
  adapter: ErpAdapter;
  fieldMappings: FieldMapping[];  // pre-loaded; empty = cycle skipped for this endpoint
  eventMappings: EventMapping[];  // pre-loaded; unknown code = record skipped
  // JWT do Supabase de um usuário deste tenant no patient-journey — usado
  // para autenticar chamadas de matching (complete_step) durante o
  // transform. null = tenant ainda não configurou o token (ver
  // db/queries/tenants.ts, getTenantAvimusToken).
  avimusApiToken: string | null;
}
