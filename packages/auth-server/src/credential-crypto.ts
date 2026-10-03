import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for upstream credentials at rest. The key comes from the
 * environment only: a lost or rotated key invalidates stored secrets instead of
 * silently falling back to a guessable default.
 */
function encryptionKey(): Buffer {
  const configured = process.env.CREDENTIAL_ENCRYPT_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
    throw new Error('CREDENTIAL_ENCRYPT_KEY must be a 32-byte hex key');
  }
  return Buffer.from(configured, 'hex');
}

// The version prefix lets a future rotation decrypt old rows while writing new
// ones; nonce and GCM tag are stored with the ciphertext because both are
// required and neither is secret.
export function encryptCredential(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptCredential(value: string): string {
  const [version, nonce, tag, ciphertext] = value.split(':');
  if (version !== 'v1' || !nonce || !tag || !ciphertext) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
