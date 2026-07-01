import type { Pool, PoolClient } from 'pg';

export interface EventMapping {
  id: string;
  endpoint_id: string;
  erp_event_code: string;
  avimus_event_id: string | null;
  avimus_action: 'complete_step' | 'start_journey';
  description: string | null;
  created_at: Date;
}

export interface EventMappingInput {
  erp_event_code: string;
  avimus_event_id?: string | null;
  avimus_action: 'complete_step' | 'start_journey';
  description?: string | null;
}

export async function getEventMappings(
  pool: Pool,
  tenantId: string,
  endpointId: string,
): Promise<EventMapping[]> {
  const { rows } = await pool.query<EventMapping>(
    `SELECT em.id, em.endpoint_id, em.erp_event_code, em.avimus_event_id,
            em.avimus_action, em.description, em.created_at
     FROM event_mappings em
     JOIN erp_endpoints ep ON em.endpoint_id = ep.id
     JOIN erp_connections ec ON ep.connection_id = ec.id
     WHERE ec.tenant_id = $1 AND em.endpoint_id = $2
     ORDER BY em.erp_event_code ASC`,
    [tenantId, endpointId],
  );
  return rows;
}

export async function replaceEventMappings(
  pool: Pool,
  tenantId: string,
  endpointId: string,
  mappings: EventMappingInput[],
): Promise<EventMapping[]> {
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
      `DELETE FROM event_mappings WHERE endpoint_id = $1`,
      [endpointId],
    );

    if (mappings.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const rows: EventMapping[] = [];
    for (const m of mappings) {
      const { rows: inserted } = await client.query<EventMapping>(
        `INSERT INTO event_mappings (endpoint_id, erp_event_code, avimus_event_id, avimus_action, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, endpoint_id, erp_event_code, avimus_event_id, avimus_action, description, created_at`,
        [endpointId, m.erp_event_code, m.avimus_event_id ?? null, m.avimus_action, m.description ?? null],
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
