import type { ErpAdapter } from '../adapters/types.js';
import { TasyAdapter } from '../adapters/tasy/index.js';
import type { ErpConnection } from '../db/queries/erp-connections.js';
import type { ErpEndpointWithCredentials } from '../db/queries/erp-endpoints.js';
import { decrypt } from '../lib/crypto.js';
import { getConfig } from './index.js';

function extractToken(credentials: string | null | undefined): string | undefined {
  if (!credentials) return undefined;
  try {
    const { encryptionKey } = getConfig();
    const plain = decrypt(credentials, encryptionKey);
    const parsed = JSON.parse(plain) as Record<string, unknown>;
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

export function createAdapter(
  erpName: string,
  connection: ErpConnection,
  endpoint: ErpEndpointWithCredentials,
): ErpAdapter {
  // Endpoint credentials take precedence; fall back to connection credentials
  const token =
    extractToken(endpoint.credentials) ?? extractToken(connection.credentials);

  switch (erpName) {
    case 'tasy':
      return new TasyAdapter({
        baseUrl: connection.base_url,
        path: endpoint.path,
        timeoutMs: connection.timeout_ms,
        token,
      });
    default:
      throw new Error(
        `Unknown ERP "${erpName}" in erp_connections. ` +
        `Register a new adapter in src/config/erp-registry.ts and src/adapters/${erpName}/.`,
      );
  }
}
