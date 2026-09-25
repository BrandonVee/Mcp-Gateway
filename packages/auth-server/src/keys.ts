import { generateKeyPairSync } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { exportJWK, importPKCS8, importSPKI, type JWK, type KeyLike } from 'jose';
import { db } from './db.js';
import { meta } from './schema.js';
import { eq } from 'drizzle-orm';

export interface SigningKeys {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

/**
 * RS256 signing keys for the auth server.
 *
 * By default a fresh RSA keypair is generated at boot (fine for dev).
 * Set AUTH_RSA_PRIVATE_KEY_PEM / AUTH_RSA_PUBLIC_KEY_PEM to keep keys
 * stable across restarts (recommended when more than one auth replica).
 */
export async function loadSigningKeys(): Promise<SigningKeys> {
  // 1) keys persisted in the database survive restarts (tokens stay valid)
  const [stored] = await db.select({ value: meta.value }).from(meta).where(eq(meta.key, 'signing_pem')).limit(1);
  if (stored) {
    const saved = JSON.parse(stored.value) as { privateKeyPem: string; publicKeyPem: string; kid: string };
    const privateKey = await importPKCS8(saved.privateKeyPem, 'RS256');
    const publicKey = await importSPKI(saved.publicKeyPem, 'RS256');
    const jwk = await exportJWK(publicKey);
    return { kid: saved.kid, privateKey, publicJwk: { ...jwk, kid: saved.kid, alg: 'RS256', use: 'sig' } };
  }

  // 2) explicit PEM env vars
  const privPem = process.env.AUTH_RSA_PRIVATE_KEY_PEM;
  const pubPem = process.env.AUTH_RSA_PUBLIC_KEY_PEM;

  let privateKeyPem: string;
  let publicKeyPem: string;
  if (privPem && pubPem) {
    privateKeyPem = privPem.replace(/\\n/g, '\n');
    publicKeyPem = pubPem.replace(/\\n/g, '\n');
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKeyPem = privateKey;
    publicKeyPem = publicKey;
  }

  const privateKey = await importPKCS8(privateKeyPem, 'RS256');
  const publicKey = await importSPKI(publicKeyPem, 'RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = randomUUID();
  await persistKeys(privateKeyPem, publicKeyPem, kid);
  return {
    kid,
    privateKey,
    publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
  };
}

async function persistKeys(privateKeyPem: string, publicKeyPem: string, kid: string): Promise<void> {
  await db
    .insert(meta)
    .values({ key: 'signing_pem', value: JSON.stringify({ privateKeyPem, publicKeyPem, kid }) })
    .onConflictDoUpdate({
      target: meta.key,
      set: { value: JSON.stringify({ privateKeyPem, publicKeyPem, kid }) },
    });
}
