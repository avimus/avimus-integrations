import type { Pool } from 'pg';

export const JOB_LOCKS = {
  SYNC_POLL_BASE: 100_000,
  SYNC_CYCLE: 100_001,   // single advisory lock covering the multi-tenant iteration loop
  OUTBOX_RELAY: 100_999,
} as const;

/** Derives a stable advisory lock ID for a named ERP adapter. */
export function erpLockId(adapterName: string): number {
  let hash = 0;
  for (let i = 0; i < adapterName.length; i++) {
    hash = (Math.imul(31, hash) + adapterName.charCodeAt(i)) | 0;
  }
  // Map into [100_000, 100_998] range, safely below OUTBOX_RELAY
  return JOB_LOCKS.SYNC_POLL_BASE + (Math.abs(hash) % 999);
}

export interface LockResult<T> {
  result: T;
  acquired: true;
}

export interface LockNotAcquired {
  acquired: false;
}

export async function withAdvisoryLock<T>(
  pool: Pool,
  lockId: number,
  fn: () => Promise<T>,
): Promise<LockResult<T> | LockNotAcquired> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockId],
    );

    if (!rows[0]?.acquired) {
      return { acquired: false };
    }

    try {
      const result = await fn();
      return { result, acquired: true };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}
