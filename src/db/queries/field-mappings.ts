import type { Pool, PoolClient } from 'pg';

export interface FieldMapping {
  id: string;
  endpoint_id: string;
  source_field: string;
  target_field: string;
  transform: string | null;
  created_at: Date;
}

export interface FieldMappingInput {
  source_field: string;
  target_field: string;
  transform?: string | null;
}

export async function getFieldMappings(
  pool: Pool,
  tenantId: string,
  endpointId: string,
): Promise<FieldMapping[]> {
  const { rows } = await pool.query<FieldMapping>(
    `SELECT fm.id, fm.endpoint_id, fm.source_field, fm.target_field, fm.transform, fm.created_at
     FROM field_mappings fm
     JOIN erp_endpoints ep ON fm.endpoint_id = ep.id
     JOIN erp_connections ec ON ep.connection_id = ec.id
     WHERE ec.tenant_id = $1 AND fm.endpoint_id = $2
     ORDER BY fm.source_field ASC`,
    [tenantId, endpointId],
  );
  return rows;
}

export async function replaceFieldMappings(
  pool: Pool,
  tenantId: string,
  endpointId: string,
  mappings: FieldMappingInput[],
): Promise<FieldMapping[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify endpoint belongs to tenant via JOIN
    const { rowCount } = await client.query(
      `SELECT 1 FROM erp_endpoints ep
       JOIN erp_connections ec ON ep.connection_id = ec.id
       WHERE ep.id = $1 AND ec.tenant_id = $2`,
      [endpointId, tenantId],
    );
    if ((rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Endpoint not found'), { statusCode: 404 });
    }

    await client.query(
      `DELETE FROM field_mappings WHERE endpoint_id = $1`,
      [endpointId],
    );

    if (mappings.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const rows: FieldMapping[] = [];
    for (const m of mappings) {
      const { rows: inserted } = await client.query<FieldMapping>(
        `INSERT INTO field_mappings (endpoint_id, source_field, target_field, transform)
         VALUES ($1, $2, $3, $4)
         RETURNING id, endpoint_id, source_field, target_field, transform, created_at`,
        [endpointId, m.source_field, m.target_field, m.transform ?? null],
      );
      rows.push(inserted[0]);
    }

    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
