import type { Pool } from 'pg';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { getConfig } from '../../config/index.js';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: Date;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
}

export interface UpdateTenantInput {
  name?: string;
  is_active?: boolean;
  // Token de acesso (JWT do Supabase) de um usuário deste tenant no
  // patient-journey — usado pelo worker para autenticar as chamadas de
  // entrega. Plaintext na entrada; armazenado criptografado.
  avimus_api_token?: string | null;
}

export async function getActiveTenants(pool: Pool): Promise<Tenant[]> {
  const { rows } = await pool.query<Tenant>(
    `SELECT id, name, slug, is_active, created_at
     FROM tenants
     WHERE is_active = true
     ORDER BY created_at ASC`,
  );
  return rows;
}

export async function getAllTenants(pool: Pool): Promise<Tenant[]> {
  const { rows } = await pool.query<Tenant>(
    `SELECT id, name, slug, is_active, created_at
     FROM tenants
     ORDER BY created_at ASC`,
  );
  return rows;
}

export async function getTenantById(pool: Pool, id: string): Promise<Tenant | null> {
  const { rows } = await pool.query<Tenant>(
    `SELECT id, name, slug, is_active, created_at
     FROM tenants
     WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createTenant(pool: Pool, input: CreateTenantInput): Promise<Tenant> {
  const { rows } = await pool.query<Tenant>(
    `INSERT INTO tenants (name, slug)
     VALUES ($1, $2)
     RETURNING id, name, slug, is_active, created_at`,
    [input.name, input.slug],
  );
  return rows[0];
}

export async function updateTenant(
  pool: Pool,
  id: string,
  input: UpdateTenantInput,
): Promise<Tenant | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(input.name);
  }
  if (input.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(input.is_active);
  }
  if (input.avimus_api_token !== undefined) {
    const { encryptionKey } = getConfig();
    const encrypted = input.avimus_api_token ? encrypt(input.avimus_api_token, encryptionKey) : null;
    sets.push(`avimus_api_token = $${idx++}`);
    values.push(encrypted);
  }

  if (sets.length === 0) return getTenantById(pool, id);

  values.push(id);
  const { rows } = await pool.query<Tenant>(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, name, slug, is_active, created_at`,
    values,
  );
  return rows[0] ?? null;
}

// Server-only — nunca exposto por nenhuma rota da API. Usado internamente
// pelo poller/outbox-worker para autenticar chamadas ao patient-journey em
// nome do tenant correto.
export async function getTenantAvimusToken(pool: Pool, tenantId: string): Promise<string | null> {
  const { rows } = await pool.query<{ avimus_api_token: string | null }>(
    `SELECT avimus_api_token FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const encrypted = rows[0]?.avimus_api_token;
  if (!encrypted) return null;

  const { encryptionKey } = getConfig();
  try {
    return decrypt(encrypted, encryptionKey);
  } catch {
    return null;
  }
}
