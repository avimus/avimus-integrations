import pg from 'pg';
import { getConfig } from '../config/index.js';

const { Pool } = pg;

export function createPool(config?: { connectionString?: string; max?: number }): pg.Pool {
  const appConfig = getConfig();
  const pool = new Pool({
    connectionString: config?.connectionString ?? appConfig.databaseUrl,
    max: config?.max ?? appConfig.dbPoolMax,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected pool error (idle client):', err);
  });

  pool.on('connect', (client) => {
    void client.query(`SET search_path TO ${appConfig.dbSchema}`);
  });

  return pool;
}

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = createPool();
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
