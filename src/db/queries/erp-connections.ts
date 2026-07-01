import type { Pool } from 'pg';
import { encrypt } from '../../lib/crypto.js';
import { getConfig } from '../../config/index.js';

export interface ErpConnection {
  id: string;
  tenant_id: string;
  erp_name: string;
  base_url: string;
  timeout_ms: number;
  credentials: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface ErpConnectionPublic {
  id: string;
  tenant_id: string;
  erp_name: string;
  base_url: string;
  timeout_ms: number;
  is_active: boolean;
  created_at: Date;
}

export interface CreateConnectionInput {
  tenant_id: string;
  erp_name: string;
  base_url: string;
  timeout_ms?: number;
  credentials?: string;
}

export interface UpdateConnectionInput {
  base_url?: string;
  timeout_ms?: number;
  credentials?: string;
  is_active?: boolean;
}

function toPublic(conn: ErpConnection): ErpConnectionPublic {
  const { credentials: _creds, ...pub } = conn;
  return pub;
}

export async function getConnectionById(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<ErpConnection | null> {
  const { rows } = await pool.query<ErpConnection>(
    `SELECT id, tenant_id, erp_name, base_url, timeout_ms, credentials, is_active, created_at
     FROM erp_connections WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export async function getActiveConnections(pool: Pool, tenantId: string): Promise<ErpConnection[]> {
  const { rows } = await pool.query<ErpConnection>(
    `SELECT id, tenant_id, erp_name, base_url, timeout_ms, credentials, is_active, created_at
     FROM erp_connections
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows;
}

export async function getAllConnections(
  pool: Pool,
  tenantId: string,
): Promise<ErpConnectionPublic[]> {
  const { rows } = await pool.query<ErpConnection>(
    `SELECT id, tenant_id, erp_name, base_url, timeout_ms, credentials, is_active, created_at
     FROM erp_connections
     WHERE tenant_id = $1
     ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows.map(toPublic);
}

export async function createConnection(
  pool: Pool,
  input: CreateConnectionInput,
): Promise<ErpConnectionPublic> {
  const { encryptionKey } = getConfig();
  const encryptedCreds =
    input.credentials != null ? encrypt(input.credentials, encryptionKey) : null;

  const { rows } = await pool.query<ErpConnection>(
    `INSERT INTO erp_connections (tenant_id, erp_name, base_url, timeout_ms, credentials)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, erp_name, base_url, timeout_ms, credentials, is_active, created_at`,
    [input.tenant_id, input.erp_name, input.base_url, input.timeout_ms ?? 10000, encryptedCreds],
  );
  return toPublic(rows[0]);
}

export async function updateConnection(
  pool: Pool,
  tenantId: string,
  id: string,
  input: UpdateConnectionInput,
): Promise<ErpConnectionPublic | null> {
  const { encryptionKey } = getConfig();
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.base_url !== undefined) {
    sets.push(`base_url = $${idx++}`);
    values.push(input.base_url);
  }
  if (input.timeout_ms !== undefined) {
    sets.push(`timeout_ms = $${idx++}`);
    values.push(input.timeout_ms);
  }
  if (input.credentials !== undefined) {
    sets.push(`credentials = $${idx++}`);
    values.push(encrypt(input.credentials, encryptionKey));
  }
  if (input.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(input.is_active);
  }

  if (sets.length === 0) {
    const { rows } = await pool.query<ErpConnection>(
      `SELECT id, tenant_id, erp_name, base_url, timeout_ms, credentials, is_active, created_at
       FROM erp_connections WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toPublic(rows[0]) : null;
  }

  values.push(id, tenantId);
  const { rows } = await pool.query<ErpConnection>(
    `UPDATE erp_connections SET ${sets.join(', ')}
     WHERE id = $${idx++} AND tenant_id = $${idx++}
     RETURNING id, tenant_id, erp_name, base_url, timeout_ms, credentials, is_active, created_at`,
    values,
  );
  return rows[0] ? toPublic(rows[0]) : null;
}

export async function softDeleteConnection(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE erp_connections SET is_active = false
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}
