import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secret encryption (TECHNICAL §13): AES-256-GCM with a key derived by HKDF-SHA256 from the
 * `ai_keys_master` Docker secret. Each key version derives a different key, so the master can
 * be rotated later by re-encrypting rows with a new `keyVersion`.
 *
 * Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. The secret name is bound as additional
 * authenticated data, so a ciphertext copied onto another row does not decrypt.
 */

export const CURRENT_KEY_VERSION = 1;

const FORMAT = 'v1';
const SALT = Buffer.from('ai-cms/secrets');
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretDecryptionError extends Error {
  constructor(message = 'Impossibile decifrare il segreto: dato manomesso o chiave errata.') {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export function deriveSecretKey(masterKey: string, keyVersion = CURRENT_KEY_VERSION): Buffer {
  if (masterKey.length < 16) throw new Error('ai_keys_master is too short (min 16 characters)');
  return Buffer.from(hkdfSync('sha256', masterKey, SALT, `ai-cms/secrets/key-v${keyVersion}`, 32));
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join(':');
}

export function decryptSecret(key: Buffer, blob: string, aad: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new SecretDecryptionError('Formato del segreto cifrato non riconosciuto.');
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptionError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretDecryptionError();
  }
}

/** What the UI may show of a secret: `…a1b2`. Short values reveal nothing. */
export function secretHint(value: string): string {
  return value.length >= 12 ? `…${value.slice(-4)}` : '…';
}
