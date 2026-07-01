import { describe, it, expect } from 'vitest';
import { erpLockId, JOB_LOCKS } from '../../../src/lib/mutex.js';

describe('erpLockId', () => {
  it('returns a number in the expected range', () => {
    const id = erpLockId('tasy');
    expect(id).toBeGreaterThanOrEqual(JOB_LOCKS.SYNC_POLL_BASE);
    expect(id).toBeLessThan(JOB_LOCKS.OUTBOX_RELAY);
  });

  it('returns the same ID for the same adapter name (stable)', () => {
    expect(erpLockId('tasy')).toBe(erpLockId('tasy'));
  });

  it('returns different IDs for different adapter names', () => {
    expect(erpLockId('tasy')).not.toBe(erpLockId('totvs'));
  });

  it('does not collide with OUTBOX_RELAY', () => {
    const names = ['tasy', 'totvs', 'sankhya', 'linx', 'sap', 'oracle'];
    for (const name of names) {
      expect(erpLockId(name)).not.toBe(JOB_LOCKS.OUTBOX_RELAY);
    }
  });
});
