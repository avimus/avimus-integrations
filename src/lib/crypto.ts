import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyBuffer(hexKey: string): Buffer {
  const buf = Buffer.from(hexKey, 'hex');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (256 bits)');
  }
  return buf;
}

/**
 * Deterministic AES-256-GCM encryption.
 * IV is derived via HMAC-SHA256(key, plaintext) so the same plaintext always
 * produces the same ciphertext — allowing equality queries in the database
 * while still encrypting CPF and other PII at rest.
 *
 * Output format (base64): IV(12) || AuthTag(16) || Ciphertext
 */
export function encrypt(plaintext: string, hexKey: string): string {
  const key = keyBuffer(hexKey);
  // Deterministic IV: HMAC-SHA256(key, plaintext), first 12 bytes
  const iv = createHmac('sha256', key).update(plaintext).digest().subarray(0, IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const key = keyBuffer(hexKey);
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid ciphertext: too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Returns true if value looks like already-encrypted base64 (not a raw CPF string). */
export function isEncrypted(value: string): boolean {
  try {
    const buf = Buffer.from(value, 'base64');
    return buf.length >= IV_LENGTH + TAG_LENGTH && !value.match(/^\d{11}$/) && !value.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
  } catch {
    return false;
  }
}

/** Constant-time equality for encrypted values (avoids timing attacks on HMAC output). */
export function encryptedEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
