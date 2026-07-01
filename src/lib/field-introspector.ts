import { unwrapRecordArray } from './unwrap-records.js';

export class IntrospectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntrospectionError';
  }
}

function flattenKeys(obj: Record<string, unknown>, prefix: string, depth: number, maxDepth: number): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (depth < maxDepth && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey, depth + 1, maxDepth));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

export async function introspectEndpoint(opts: {
  baseUrl: string;
  path: string;
  token?: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const { baseUrl, path, token, timeoutMs = 15_000 } = opts;

  const url = new URL(path, baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url.toString(), { headers, signal: controller.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new IntrospectionError(
        `ERP unreachable: ${msg} (timeout ${timeoutMs}ms)`,
      );
    }

    if (!response.ok) {
      throw new IntrospectionError(
        `ERP returned HTTP ${response.status}: ${response.statusText}`,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new IntrospectionError('ERP response is not valid JSON');
    }

    const records = unwrapRecordArray(data);
    const first = records ? records[0] : data;

    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      throw new IntrospectionError('ERP response does not contain a JSON object to introspect');
    }

    return flattenKeys(first as Record<string, unknown>, '', 0, 2);
  } finally {
    clearTimeout(timeout);
  }
}
