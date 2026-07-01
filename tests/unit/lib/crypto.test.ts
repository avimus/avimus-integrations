import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted } from '../../../src/lib/crypto.js';

const TEST_KEY = 'a'.repeat(64); // 256-bit hex key for tests

describe('crypto', () => {
  it('encrypts and decrypts a CPF correctly', () => {
    const cpf = '12345678901';
    const ciphertext = encrypt(cpf, TEST_KEY);
    expect(decrypt(ciphertext, TEST_KEY)).toBe(cpf);
  });

  it('produces the same ciphertext for the same input (deterministic)', () => {
    const cpf = '98765432100';
    expect(encrypt(cpf, TEST_KEY)).toBe(encrypt(cpf, TEST_KEY));
  });

  it('produces different ciphertexts for different inputs', () => {
    expect(encrypt('11111111111', TEST_KEY)).not.toBe(encrypt('22222222222', TEST_KEY));
  });

  it('isEncrypted returns false for a raw CPF', () => {
    expect(isEncrypted('12345678901')).toBe(false);
  });

  it('isEncrypted returns true for encrypted output', () => {
    const ciphertext = encrypt('12345678901', TEST_KEY);
    expect(isEncrypted(ciphertext)).toBe(true);
  });

  it('throws when decrypting with wrong key', () => {
    const ciphertext = encrypt('12345678901', TEST_KEY);
    const wrongKey = 'b'.repeat(64);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it('throws on ciphertext truncation', () => {
    const ciphertext = encrypt('12345678901', TEST_KEY);
    const truncated = ciphertext.slice(0, 10);
    expect(() => decrypt(truncated, TEST_KEY)).toThrow();
  });
});
