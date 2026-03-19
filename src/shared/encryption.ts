import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Pad or slice a key to exactly 32 bytes for AES-256.
 */
function normalizeKey(key: string): Buffer {
  const buf = Buffer.from(key, 'utf8');
  if (buf.length >= KEY_LENGTH) return buf.subarray(0, KEY_LENGTH);
  // Pad with zeros to reach 32 bytes
  const padded = Buffer.alloc(KEY_LENGTH);
  buf.copy(padded);
  return padded;
}

/**
 * Encrypt plaintext using AES-256-CBC with a random IV.
 * Returns a string in the format `ivHex:cipherHex`.
 */
export function encrypt(plaintext: string, key: string): string {
  if (!plaintext) throw new Error('encrypt: plaintext must not be empty');
  if (!key) throw new Error('encrypt: key must not be empty');

  const keyBuf = normalizeKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a ciphertext string produced by `encrypt()`.
 * Expects `ivHex:cipherHex` format.
 */
export function decrypt(ciphertext: string, key: string): string {
  if (!ciphertext) throw new Error('decrypt: ciphertext must not be empty');
  if (!key) throw new Error('decrypt: key must not be empty');

  const parts = ciphertext.split(':');
  if (parts.length !== 2) {
    throw new Error('decrypt: invalid ciphertext format (expected ivHex:cipherHex)');
  }

  const [ivHex, encryptedHex] = parts;
  const keyBuf = normalizeKey(key);
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
