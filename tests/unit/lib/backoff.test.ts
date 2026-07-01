import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../../src/lib/backoff.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(op, { maxAttempts: 3, baseMs: 0, capMs: 0 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('timeout'), { status: 503 });
      return 'ok';
    });
    const result = await withRetry(op, { maxAttempts: 3, baseMs: 0, capMs: 0 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('throws after maxAttempts exhausted', async () => {
    const err = Object.assign(new Error('server error'), { status: 500 });
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op, { maxAttempts: 3, baseMs: 0, capMs: 0 })).rejects.toThrow('server error');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent errors (404)', async () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    const op = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(op, { maxAttempts: 3, baseMs: 0, capMs: 0, shouldRetry: (e) => {
        const s = (e as { status?: number }).status;
        return s !== undefined && [408, 429, 500, 502, 503, 504].includes(s);
      }}),
    ).rejects.toThrow('not found');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('aborts when signal is aborted before first attempt', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    const op = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(op, { signal: controller.signal })).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(0);
  });

  it('calls onRetry with correct attempt info', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error('retry me'), { status: 503 });
      return 'done';
    });
    await withRetry(op, { maxAttempts: 3, baseMs: 0, capMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1 });
  });
});
