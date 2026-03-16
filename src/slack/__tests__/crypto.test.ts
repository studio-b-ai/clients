import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptToken, decryptToken } from '../crypto.js';

function generateHexKey(): string {
  return randomBytes(32).toString('hex');
}

describe('Token Encryption (AES-256-GCM)', () => {
  it('round-trip: encrypt then decrypt returns original token', () => {
    const key = generateHexKey();
    const token = 'EXAMPLE-REDACTED-TEST-TOKEN';

    const ciphertext = encryptToken(token, key);
    const decrypted = decryptToken(ciphertext, key);

    expect(decrypted).toBe(token);
  });

  it('random IV: encrypting same token twice produces different ciphertext', () => {
    const key = generateHexKey();
    const token = 'xoxb-same-token-twice';

    const ciphertext1 = encryptToken(token, key);
    const ciphertext2 = encryptToken(token, key);

    expect(ciphertext1).not.toBe(ciphertext2);
  });

  it('wrong key: decrypting with wrong key throws', () => {
    const key1 = generateHexKey();
    const key2 = generateHexKey();
    const token = 'xoxb-secret-token';

    const ciphertext = encryptToken(token, key1);

    expect(() => decryptToken(ciphertext, key2)).toThrow();
  });
});
