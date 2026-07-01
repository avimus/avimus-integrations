import type { Pool } from 'pg';
import { safeLog } from '../../lib/logger.js';

export interface AuditEntry {
  tenantId?: string;
  action: string;
  component: string;
  recordType?: string;
  recordId?: string;
  erpName?: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

export async function logAudit(pool: Pool, entry: AuditEntry): Promise<void> {
  const sanitizedDetails = entry.details ? safeLog(entry.details) : null;

  await pool.query(
    `INSERT INTO audit_log (tenant_id, action, component, record_type, record_id, erp_name, details, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.tenantId ?? null,
      entry.action,
      entry.component,
      entry.recordType ?? null,
      entry.recordId ?? null,
      entry.erpName ?? null,
      sanitizedDetails ? JSON.stringify(sanitizedDetails) : null,
      entry.correlationId ?? null,
    ],
  );
}
