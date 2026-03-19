import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../encryption.js';

describe('encryption', () => {
  const key = 'my-secret-encryption-key-for-testing';

  it('roundtrips plaintext through encrypt/decrypt', () => {
    const plaintext = 'hello world';
    const ciphertext = encrypt(plaintext, key);
    const result = decrypt(ciphertext, key);
    expect(result).toBe(plaintext);
  });

  it('handles long plaintext', () => {
    const plaintext = 'x'.repeat(10_000);
    const ciphertext = encrypt(plaintext, key);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  it('handles unicode plaintext', () => {
    const plaintext = 'Ästhetik — Heritage Fabrics 🧵';
    const ciphertext = encrypt(plaintext, key);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  it('produces different ciphertext for each call (random IV)', () => {
    const plaintext = 'same input';
    const c1 = encrypt(plaintext, key);
    const c2 = encrypt(plaintext, key);
    expect(c1).not.toBe(c2);
    // Both should still decrypt to the same value
    expect(decrypt(c1, key)).toBe(plaintext);
    expect(decrypt(c2, key)).toBe(plaintext);
  });

  it('outputs ivHex:cipherHex format', () => {
    const ciphertext = encrypt('test', key);
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(2);
    // IV should be 16 bytes = 32 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    // Cipher should be non-empty hex
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
  });

  it('works with short keys (padded to 32 bytes)', () => {
    const shortKey = 'abc';
    const ciphertext = encrypt('test', shortKey);
    expect(decrypt(ciphertext, shortKey)).toBe('test');
  });

  it('works with long keys (sliced to 32 bytes)', () => {
    const longKey = 'a'.repeat(100);
    const ciphertext = encrypt('test', longKey);
    expect(decrypt(ciphertext, longKey)).toBe('test');
  });

  it('fails to decrypt with wrong key', () => {
    const ciphertext = encrypt('secret', 'key-one');
    expect(() => decrypt(ciphertext, 'key-two')).toThrow();
  });

  it('throws on empty plaintext', () => {
    expect(() => encrypt('', key)).toThrow('plaintext must not be empty');
  });

  it('throws on empty key', () => {
    expect(() => encrypt('test', '')).toThrow('key must not be empty');
  });

  it('throws on invalid ciphertext format', () => {
    expect(() => decrypt('not-valid-format', key)).toThrow('invalid ciphertext format');
  });
});
