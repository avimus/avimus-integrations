import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

// Schema keys match actual env var names (SCREAMING_SNAKE_CASE) then transform to camelCase
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  AVIMUS_API_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(1),
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  INITIAL_LOOKBACK_HOURS: z.coerce.number().int().min(1).default(24),
  MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  POLLING_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(10),
  WORKER_API_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  WORKER_API_SECRET: z.string().min(1),
  DB_SCHEMA: z.string().default('integrations'),
}).transform((env) => ({
  databaseUrl: env.DATABASE_URL,
  dbPoolMax: env.DB_POOL_MAX,
  avimusApiUrl: env.AVIMUS_API_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  initialLookbackHours: env.INITIAL_LOOKBACK_HOURS,
  maxRetries: env.MAX_RETRIES,
  pollingIntervalMinutes: env.POLLING_INTERVAL_MINUTES,
  workerApiPort: env.WORKER_API_PORT,
  workerApiSecret: env.WORKER_API_SECRET,
  dbSchema: env.DB_SCHEMA,
}));

export type Config = z.output<typeof EnvSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}
