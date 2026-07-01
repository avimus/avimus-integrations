import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const logger = console;

async function migrate(): Promise<void> {
  const schema = process.env.DB_SCHEMA ?? 'integrations';
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`SET search_path TO ${schema}`);

  const migrationsDir = resolve(import.meta.dirname, 'migrations');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const appliedSet = new Set(applied.map((r) => r.version));

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.info(`Skipping already-applied migration: ${file}`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      try {
        await client.query('BEGIN');
        logger.info(`Running migration: ${file}`);
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`Migration completed: ${file}`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    if (ran === 0) {
      logger.info('All migrations already applied — nothing to run');
    } else {
      logger.info(`${ran} migration(s) applied successfully`);
    }
  } catch (err) {
    logger.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
