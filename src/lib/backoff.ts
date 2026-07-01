export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function getRetryAfterMs(err: unknown): number | null {
  if (err && typeof err === 'object' && 'headers' in err) {
    const headers = (err as { headers: { get?: (name: string) => string | null } }).headers;
    if (headers && typeof headers.get === 'function') {
      const header = headers.get('Retry-After');
      if (header) {
        const seconds = Number(header);
        return Number.isFinite(seconds) ? seconds * 1000 : null;
      }
    }
  }
  return null;
}

const DEFAULT_SHOULD_RETRY = (err: unknown): boolean => {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
  }
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (err instanceof Error && err.message?.includes('ECONNREFUSED')) return true;
  if (err instanceof Error && err.message?.includes('ETIMEDOUT')) return true;
  return false;
};

export async function withRetry<T>(
  op: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const capMs = opts.capMs ?? 10_000;
  const shouldRetry = opts.shouldRetry ?? DEFAULT_SHOULD_RETRY;
  const controller = new AbortController();
  const signal = opts.signal
    ? anySignal([opts.signal, controller.signal])
    : controller.signal;

  if (signal.aborted) throw signal.reason;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op(signal);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }

      const expo = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const jittered = Math.random() * expo;
      const hint = getRetryAfterMs(err);
      const delayMs = hint !== null ? Math.max(jittered, hint) : jittered;

      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}
