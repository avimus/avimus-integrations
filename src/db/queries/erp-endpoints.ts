import type { Pool, PoolClient } from 'pg';
import { encrypt } from '../../lib/crypto.js';
import { getConfig } from '../../config/index.js';

export interface ErpEndpoint {
  id: string;
  connection_id: string;
  path: string;
  is_active: boolean;
  created_at: Date;
}

export interface ErpEndpointWithCredentials extends ErpEndpoint {
  credentials: string | null;
}

export interface CreateEndpointInput {
  connection_id: string;
  path: string;
  credentials?: string | null;
  is_active?: boolean;
}

export interface UpdateEndpointInput {
  path?: string;
  credentials?: string | null;
  is_active?: boolean;
}

function toPublic(row: ErpEndpointWithCredentials): ErpEndpoint {
  const { credentials: _creds, ...pub } = row;
  return pub;
}

export async function getActiveEndpoints(pool: Pool, connectionId: string): Promise<ErpEndpointWithCredentials[]> {
  const { rows } = await pool.query<ErpEndpointWithCredentials>(
    `SELECT id, connection_id, path, credentials, is_active, created_at
     FROM erp_endpoints
     WHERE connection_id = $1 AND is_active = true
     ORDER BY created_at ASC`,
    [connectionId],
  );
  return rows;
}

export async function getAllEndpoints(
  pool: Pool,
  tenantId: string,
  connectionId: string,
): Promise<ErpEndpoint[]> {
  const { rows } = await pool.query<ErpEndpointWithCredentials>(
    `SELECT ep.id, ep.connection_id, ep.path, ep.credentials, ep.is_active, ep.created_at
     FROM erp_endpoints ep
     JOIN erp_connections ec ON ep.connection_id = ec.id
     WHERE ec.tenant_id = $1 AND ep.connection_id = $2
     ORDER BY ep.created_at ASC`,
    [tenantId, connectionId],
  );
  return rows.map(toPublic);
}

export async function getEndpointById(
  pool: Pool,
  tenantId: string,
  connectionId: string,
  endpointId: string,
): Promise<ErpEndpointWithCredentials | null> {
  const { rows } = await pool.query<ErpEndpointWithCredentials>(
    `SELECT ep.id, ep.connection_id, ep.path, ep.credentials, ep.is_active, ep.created_at
     FROM erp_endpoints ep
     JOIN erp_connections ec ON ep.connection_id = ec.id
     WHERE ec.tenant_id = $1 AND ep.connection_id = $2 AND ep.id = $3`,
    [tenantId, connectionId, endpointId],
  );
  return rows[0] ?? null;
}

export async function createEndpoint(
  pool: Pool,
  tenantId: string,
  connectionId: string,
  input: CreateEndpointInput,
): Promise<ErpEndpoint> {
  const { encryptionKey } = getConfig();
  const encryptedCreds =
    input.credentials != null ? encrypt(input.credentials, encryptionKey) : null;

  const client: PoolClient = await pool.connect();
  try {
    // Verify connection belongs to tenant
    const { rowCount } = await client.query(
      'SELECT 1 FROM erp_connections WHERE id = $1 AND tenant_id = $2',
      [connectionId, tenantId],
    );
    if ((rowCount ?? 0) === 0) {
      throw Object.assign(new Error('Connection not found'), { statusCode: 404 });
    }

    const { rows } = await client.query<ErpEndpointWithCredentials>(
      `INSERT INTO erp_endpoints (connection_id, path, credentials, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, connection_id, path, credentials, is_active, created_at`,
      [connectionId, input.path, encryptedCreds, input.is_active ?? true],
    );
    return toPublic(rows[0]);
  } finally {
    client.release();
  }
}

export async function updateEndpoint(
  pool: Pool,
  tenantId: string,
  connectionId: string,
  endpointId: string,
  input: UpdateEndpointInput,
): Promise<ErpEndpoint | null> {
  const { encryptionKey } = getConfig();
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.path !== undefined) {
    sets.push(`path = $${idx++}`);
    values.push(input.path);
  }
  if (input.credentials !== undefined) {
    sets.push(`credentials = $${idx++}`);
    values.push(input.credentials != null ? encrypt(input.credentials, encryptionKey) : null);
  }
  if (input.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(input.is_active);
  }

  if (sets.length === 0) {
    return getEndpointById(pool, tenantId, connectionId, endpointId).then((r) =>
      r ? toPublic(r) : null,
    );
  }

  values.push(endpointId, connectionId, tenantId);
  const { rows } = await pool.query<ErpEndpointWithCredentials>(
    `UPDATE erp_endpoints ep
     SET ${sets.join(', ')}
     FROM erp_connections ec
     WHERE ep.connection_id = ec.id
       AND ep.id = $${idx++}
       AND ep.connection_id = $${idx++}
       AND ec.tenant_id = $${idx++}
     RETURNING ep.id, ep.connection_id, ep.path, ep.credentials, ep.is_active, ep.created_at`,
    values,
  );
  return rows[0] ? toPublic(rows[0]) : null;
}

export async function softDeleteEndpoint(
  pool: Pool,
  tenantId: string,
  connectionId: string,
  endpointId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE erp_endpoints ep
     SET is_active = false
     FROM erp_connections ec
     WHERE ep.connection_id = ec.id
       AND ep.id = $1
       AND ep.connection_id = $2
       AND ec.tenant_id = $3`,
    [endpointId, connectionId, tenantId],
  );
  return (rowCount ?? 0) > 0;
}
