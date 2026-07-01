import type { Pool } from 'pg';

export async function getLastSyncedAt(
  pool: Pool,
  endpointId: string,
): Promise<Date | null> {
  const { rows } = await pool.query<{ last_synced_at: Date | null }>(
    'SELECT last_synced_at FROM sync_state WHERE endpoint_id = $1',
    [endpointId],
  );
  return rows[0]?.last_synced_at ?? null;
}

export async function updateSyncState(
  pool: Pool,
  tenantId: string,
  endpointId: string,
  timestamp: Date,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE sync_state
     SET last_synced_at = $2, updated_at = now()
     WHERE endpoint_id = $1`,
    [endpointId, timestamp],
  );

  if (rowCount === 0) {
    await pool.query(
      `INSERT INTO sync_state (tenant_id, endpoint_id, last_synced_at)
       VALUES ($1, $2, $3)`,
      [tenantId, endpointId, timestamp],
    );
  }
}
