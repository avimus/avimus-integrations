import type { Pool } from 'pg';

export type DropReason = 'missing_field' | 'no_event_mapping' | 'no_active_journey' | 'no_matching_step';

export interface InsertDroppedEventInput {
  tenantId: string;
  endpointId: string;
  erpEventCode?: string | null;
  dropReason: DropReason;
  cpfMasked?: string | null;
  protocolId?: string | null;
}

export async function insertDroppedEvent(pool: Pool, input: InsertDroppedEventInput): Promise<void> {
  await pool.query(
    `INSERT INTO dropped_events (tenant_id, endpoint_id, erp_event_code, drop_reason, cpf_masked, protocol_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.endpointId,
      input.erpEventCode ?? null,
      input.dropReason,
      input.cpfMasked ?? null,
      input.protocolId ?? null,
    ],
  );
}

export interface ListDroppedEventsInput {
  tenantId: string;
  limit: number;
  cursor?: string;
}

export interface DroppedEventRecord {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  erp_event_code: string | null;
  drop_reason: DropReason;
  cpf_masked: string | null;
  protocol_id: string | null;
  created_at: Date;
}

export interface DroppedEventsPage {
  records: DroppedEventRecord[];
  next_cursor: string | null;
}

// Mesmo esquema de cursor (base64url de {t, i}) já usado em outbox.ts —
// mantém a paginação consistente entre as duas listas do admin.
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id })).toString('base64url');
}

function decodeCursor(cursor: string): { t: string; i: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).t === 'string' &&
      typeof (parsed as Record<string, unknown>).i === 'string'
    ) {
      return parsed as { t: string; i: string };
    }
    return null;
  } catch {
    return null;
  }
}

export async function listDroppedEvents(pool: Pool, input: ListDroppedEventsInput): Promise<DroppedEventsPage> {
  const { tenantId, limit, cursor } = input;

  const conditions: string[] = ['tenant_id = $1'];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
    conditions.push(`(created_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`);
    values.push(decoded.t, decoded.i);
  }

  values.push(limit + 1);
  const { rows } = await pool.query<DroppedEventRecord>(
    `SELECT id, tenant_id, endpoint_id, erp_event_code, drop_reason, cpf_masked, protocol_id, created_at
     FROM dropped_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${idx}`,
    values,
  );

  const hasMore = rows.length > limit;
  const records = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(records[records.length - 1].created_at, records[records.length - 1].id) : null;

  return { records, next_cursor: nextCursor };
}
