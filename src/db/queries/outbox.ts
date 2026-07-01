import type { Pool } from 'pg';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { getConfig } from '../../config/index.js';
import { maskCpf } from '../../lib/mask.js';

export interface OutboxRecord {
  id: string;
  aggregate_type: string;
  aggregate_id: string; // decrypted CPF after read
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  correlation_id: string;
  erp_name: string;
  tenant_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueInput {
  tenantId: string;             // mandatory — application layer rejects null
  aggregateId: string;          // plain-text CPF — encrypted before storage
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string;
  erpName: string;
}

export async function enqueue(pool: Pool, input: EnqueueInput): Promise<string> {
  const { encryptionKey } = getConfig();
  const encryptedId = encrypt(input.aggregateId, encryptionKey);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, erp_name)
     VALUES ($1, 'patient_journey', $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.tenantId,
      encryptedId,
      input.eventType,
      JSON.stringify(input.payload),
      input.correlationId,
      input.erpName,
    ],
  );
  return rows[0].id;
}

export async function claimPending(pool: Pool, limit: number): Promise<OutboxRecord[]> {
  // Single-worker exclusion is guaranteed by the caller's advisory lock.
  const { rows } = await pool.query<OutboxRecord>(
    `SELECT * FROM outbox
     WHERE status = 'pendente'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  const { encryptionKey } = getConfig();
  return rows.map((r) => ({
    ...r,
    aggregate_id: decrypt(r.aggregate_id, encryptionKey),
  }));
}

export async function markSent(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE outbox SET status = 'enviado', updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function markFailed(
  pool: Pool,
  id: string,
  error: string,
  correlationId: string,
): Promise<void> {
  await pool.query(
    `UPDATE outbox SET status = 'falhou', last_error = $2, correlation_id = $3, updated_at = now() WHERE id = $1`,
    [id, error, correlationId],
  );
}

export interface ListOutboxInput {
  tenantId: string;
  status?: 'pendente' | 'enviado' | 'falhou';
  date?: string;
  limit: number;
  cursor?: string;
}

export interface OutboxListRecord {
  id: string;
  tenant_id: string;
  status: string;
  event_type: string;
  cpf_masked: string;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

export interface OutboxPage {
  records: OutboxListRecord[];
  next_cursor: string | null;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

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

export async function listOutbox(pool: Pool, input: ListOutboxInput): Promise<OutboxPage> {
  const { encryptionKey } = getConfig();
  const { tenantId, status, date, limit, cursor } = input;

  const conditions: string[] = ['tenant_id = $1'];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }
  if (date) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(date);
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
    conditions.push(`(created_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`);
    values.push(decoded.t, decoded.i);
  }

  values.push(limit + 1);
  const { rows } = await pool.query<OutboxRow>(
    `SELECT id, tenant_id, aggregate_id, event_type, status, attempt_count, last_error, created_at
     FROM outbox
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${idx}`,
    values,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1].created_at, pageRows[pageRows.length - 1].id) : null;

  const records: OutboxListRecord[] = pageRows.map((row) => {
    let cpfMasked = '***';
    try {
      const plain = decrypt(row.aggregate_id, encryptionKey);
      cpfMasked = maskCpf(plain);
    } catch {
      // aggregate_id could not be decrypted — leave masked placeholder
    }
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      status: row.status,
      event_type: row.event_type,
      cpf_masked: cpfMasked,
      attempt_count: row.attempt_count,
      last_error: row.last_error,
      created_at: row.created_at,
    };
  });

  return { records, next_cursor: nextCursor };
}

export async function retryOutboxRecord(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE outbox
     SET status = 'pendente', attempt_count = 0, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'falhou'`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export async function hasRecentSuccess(
  pool: Pool,
  tenantId: string,
  aggregateId: string, // plain-text CPF
  eventType: string,
  stepId: string,
): Promise<boolean> {
  const { encryptionKey } = getConfig();
  const encryptedId = encrypt(aggregateId, encryptionKey);

  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM outbox
       WHERE tenant_id = $1
         AND aggregate_id = $2
         AND event_type = $3
         AND payload->>'stepId' = $4
         AND status = 'enviado'
         AND created_at > now() - interval '24 hours'
     ) AS exists`,
    [tenantId, encryptedId, eventType, stepId],
  );
  return rows[0]?.exists ?? false;
}
