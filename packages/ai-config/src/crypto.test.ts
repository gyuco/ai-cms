import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  SecretDecryptionError,
  secretHint,
} from './crypto.ts';

const master = 'a-long-enough-master-key-for-tests';
const key = deriveSecretKey(master);

function tamper(blob: string, index: number): string {
  const parts = blob.split(':');
  const bytes = Buffer.from(parts[index]!, 'base64');
  bytes[0] = bytes[0]! ^ 0x01;
  parts[index] = bytes.toString('base64');
  return parts.join(':');
}

describe('secret encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret(key, 'sk-ant-api-1234567890', 'ai/anthropic');
    const b = encryptSecret(key, 'sk-ant-api-1234567890', 'ai/anthropic');
    expect(a).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-ant');
    expect(decryptSecret(key, a, 'ai/anthropic')).toBe('sk-ant-api-1234567890');
  });

  it('detects tampering with the IV, the tag or the ciphertext', () => {
    const blob = encryptSecret(key, 'secret value', 'n');
    for (const index of [1, 2, 3]) {
      expect(() => decryptSecret(key, tamper(blob, index), 'n')).toThrow(SecretDecryptionError);
    }
  });

  it('rejects a wrong key, another key version or another name', () => {
    const blob = encryptSecret(key, 'secret value', 'ai/a');
    expect(() => decryptSecret(deriveSecretKey('another-master-key-value'), blob, 'ai/a')).toThrow(
      SecretDecryptionError,
    );
    expect(() => decryptSecret(deriveSecretKey(master, 2), blob, 'ai/a')).toThrow(
      SecretDecryptionError,
    );
    expect(() => decryptSecret(key, blob, 'ai/b')).toThrow(SecretDecryptionError);
  });

  it('rejects unknown formats and short master keys', () => {
    expect(() => decryptSecret(key, 'v2:a:b:c', 'n')).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(key, 'garbage', 'n')).toThrow(SecretDecryptionError);
    expect(() => deriveSecretKey('short')).toThrow();
  });

  it('builds hints that reveal only the last four characters of long values', () => {
    expect(secretHint('sk-ant-api03-xxxxxxxxa1b2')).toBe('…a1b2');
    expect(secretHint('short')).toBe('…');
  });
});
