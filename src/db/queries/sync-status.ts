import type { Pool } from 'pg';

export interface EndpointSyncStatus {
  endpoint_id: string;
  path: string;
  fetch_url: string;
  is_active: boolean;
  last_synced_at: Date | null;
  next_sync_at: Date | null;
  today: {
    fetched: number;
    enqueued: number;
    delivered: number;
    failed: number;
  };
}

export interface ConnectionSyncStatus {
  connection_id: string;
  erp_name: string;
  base_url: string;
  endpoints: EndpointSyncStatus[];
}

interface SyncStatusRow {
  connection_id: string;
  erp_name: string;
  base_url: string;
  endpoint_id: string;
  path: string;
  is_active: boolean;
  last_synced_at: Date | null;
  fetched_today: string;
  enqueued_today: string;
  delivered_today: string;
  failed_today: string;
}

export async function getSyncStatus(
  pool: Pool,
  tenantId: string,
  pollingIntervalMinutes: number,
): Promise<ConnectionSyncStatus[]> {
  const { rows } = await pool.query<SyncStatusRow>(
    `SELECT
       ec.id AS connection_id,
       ec.erp_name,
       ec.base_url,
       ep.id AS endpoint_id,
       ep.path,
       ep.is_active,
       ss.last_synced_at,
       COALESCE(SUM((al.details->>'fetched')::int)   FILTER (WHERE al.action = 'sync_cycle.complete'), 0) AS fetched_today,
       COALESCE(SUM((al.details->>'enqueued')::int)  FILTER (WHERE al.action = 'sync_cycle.complete'), 0) AS enqueued_today,
       COUNT(*) FILTER (WHERE al.action = 'delivery.success')  AS delivered_today,
       COUNT(*) FILTER (WHERE al.action = 'delivery.failed')   AS failed_today
     FROM erp_connections ec
     JOIN erp_endpoints ep ON ep.connection_id = ec.id
     LEFT JOIN sync_state ss ON ss.endpoint_id = ep.id
     LEFT JOIN audit_log al
       ON al.tenant_id = ec.tenant_id
       AND (al.details->>'endpointId') = ep.id::text
       AND al.timestamp >= date_trunc('day', now() AT TIME ZONE 'UTC')
     WHERE ec.tenant_id = $1 AND ec.is_active = true
     GROUP BY ec.id, ec.erp_name, ec.base_url, ep.id, ep.path, ep.is_active, ss.last_synced_at
     ORDER BY ec.erp_name ASC, ep.path ASC`,
    [tenantId],
  );

  // Group by connection
  const connectionMap = new Map<string, ConnectionSyncStatus>();

  for (const row of rows) {
    if (!connectionMap.has(row.connection_id)) {
      connectionMap.set(row.connection_id, {
        connection_id: row.connection_id,
        erp_name: row.erp_name,
        base_url: row.base_url,
        endpoints: [],
      });
    }

    let nextSyncAt: Date | null = null;
    if (row.last_synced_at) {
      nextSyncAt = new Date(row.last_synced_at.getTime() + pollingIntervalMinutes * 60 * 1000);
    }

    const fetchUrl = `${row.base_url.replace(/\/$/, '')}${row.path}`;

    connectionMap.get(row.connection_id)!.endpoints.push({
      endpoint_id: row.endpoint_id,
      path: row.path,
      fetch_url: fetchUrl,
      is_active: row.is_active,
      last_synced_at: row.last_synced_at,
      next_sync_at: nextSyncAt,
      today: {
        fetched: parseInt(row.fetched_today, 10),
        enqueued: parseInt(row.enqueued_today, 10),
        delivered: parseInt(row.delivered_today as string, 10),
        failed: parseInt(row.failed_today as string, 10),
      },
    });
  }

  return [...connectionMap.values()];
}
