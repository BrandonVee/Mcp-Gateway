import { eq } from 'drizzle-orm';
import { exportJWK, importPKCS8, importSPKI, type JWK, type KeyLike } from 'jose';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { db } from '../../infrastructure/database/client.js';
import { meta } from '../../infrastructure/database/schema.js';

export interface SigningKeys {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

/**
 * 数据库中的签名密钥优先，保证重启后的既有令牌仍可验证。
 * 首次初始化可从 PEM 环境变量导入，否则生成密钥并持久化；这里不启动 HTTP 服务。
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

  const kid = randomUUID();
  await persistKeys(privateKeyPem, publicKeyPem, kid);
  // Another replica may have inserted its key first. Always use the winner.
  return loadSigningKeys();
}

async function persistKeys(privateKeyPem: string, publicKeyPem: string, kid: string): Promise<void> {
  await db
    .insert(meta)
    .values({ key: 'signing_pem', value: JSON.stringify({ privateKeyPem, publicKeyPem, kid }) })
    .onConflictDoNothing({ target: meta.key });
}
