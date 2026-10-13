import { and, eq } from 'drizzle-orm';
import { db, type AuthTransaction } from '../../infrastructure/database/client.js';
import { LockNamespace, lockTransaction } from '../../infrastructure/database/locks.js';
import {
  mcpServerInstances,
  mcpServers,
  upstreamCredentials,
  users,
  userServerAccess,
} from '../../infrastructure/database/schema.js';
import { decryptCredential, encryptCredential } from '../../infrastructure/security/credential-crypto.js';
import { accessTokenValid, exchangeOAuthToken, OAuthTokenError, shouldRefresh, tokenExpiry } from './token-exchange.js';

export type Identity = { id: number; authVersion: number; role: 'admin' | 'user' };

/** Parent -> upstream -> user -> grant -> credential: the common lock order. */
export async function lockUpstream(tx: AuthTransaction, id: string, user: Identity, revision?: number) {
  const [lookup] = await tx
    .select({ parent: mcpServerInstances.serverName })
    .from(mcpServerInstances)
    .where(eq(mcpServerInstances.id, id));
  if (!lookup) return null;
  const [parent] = await tx.select().from(mcpServers).where(eq(mcpServers.name, lookup.parent)).for('share');
  const [upstream] = await tx.select().from(mcpServerInstances).where(eq(mcpServerInstances.id, id)).for('share');
  if (
    !parent?.enabled ||
    !upstream?.enabled ||
    upstream.serverName !== parent.name ||
    (revision !== undefined && upstream.authRevision !== revision)
  )
    return null;
  const [account] = await tx.select().from(users).where(eq(users.id, user.id)).for('share');
  if (!account || account.disabled || account.authVersion !== user.authVersion) return null;
  if (account.role !== 'admin' && !account.allServers) {
    const [grant] = await tx
      .select()
      .from(userServerAccess)
      .where(and(eq(userServerAccess.userId, user.id), eq(userServerAccess.serverName, parent.name)))
      .for('share');
    if (!grant) return null;
  }
  return { upstream, parent, account };
}

export const ownerFor = (system: boolean, userId: number) => (system ? 'system' : `user:${userId}`);

export async function lockOwner(tx: AuthTransaction, id: string, owner: string) {
  await lockTransaction(tx, LockNamespace.UpstreamCredential, `${id}:${owner}`);
}

export type CredentialHeader = { header: string; value: string };
export type CredentialResolution =
  | { denied: true }
  | { configChanged: true }
  | { missing: true; system: boolean }
  | { credential: CredentialHeader | null; revision: number };

/**
 * 同一事务内检查用户授权、地址与认证修订号，再读取当前 owner 的凭据。
 * 系统 OAuth 的 owner 独立于管理员个人账号；刷新串行化，避免轮换令牌被并发覆盖。
 */
export async function resolveUpstreamCredential(
  id: string,
  identity: Identity,
  endpoint?: string,
  expectedUrl?: string,
): Promise<CredentialResolution> {
  return db.transaction(async (tx) => {
    const locked = await lockUpstream(tx, id, identity);
    if (!locked || (endpoint !== undefined && locked.parent.name !== endpoint)) return { denied: true as const };
    const s = locked.upstream;
    if (expectedUrl !== undefined && s.url !== expectedUrl) return { configChanged: true as const };
    if (s.authMode === 'none') return { credential: null, revision: s.authRevision };
    if (s.authMode === 'system_api_key')
      return s.systemApiKey
        ? {
            credential: { header: s.apiKeyHeader, value: s.apiKeyPrefix + decryptCredential(s.systemApiKey) },
            revision: s.authRevision,
          }
        : { missing: true as const, system: true };
    const system = s.authMode === 'system_oauth';
    const owner = ownerFor(system, identity.id);
    await lockOwner(tx, id, owner);
    const [row] = await tx
      .select()
      .from(upstreamCredentials)
      .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, owner)))
      .for('update');
    const mode = s.authMode === 'api_key' ? 'api_key' : 'oauth';
    if (!row || row.mode !== mode) return { missing: true as const, system };
    if (mode === 'api_key')
      return {
        credential: { header: s.apiKeyHeader, value: s.apiKeyPrefix + decryptCredential(row.secret) },
        revision: s.authRevision,
      };
    if (shouldRefresh(row.expiresAt, Boolean(row.refreshSecret))) {
      try {
        const body = await exchangeOAuthToken(
          s,
          new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptCredential(row.refreshSecret!) }),
        );
        const values = {
          secret: encryptCredential(body.access_token),
          refreshSecret:
            typeof body.refresh_token === 'string' && body.refresh_token
              ? encryptCredential(body.refresh_token)
              : row.refreshSecret,
          expiresAt: tokenExpiry(body),
          updatedAt: Date.now(),
        };
        await tx
          .update(upstreamCredentials)
          .set(values)
          .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, owner)));
        return {
          credential: { header: 'authorization', value: `Bearer ${body.access_token}` },
          revision: s.authRevision,
        };
      } catch (error) {
        if (error instanceof OAuthTokenError && error.permanent) {
          await tx
            .update(upstreamCredentials)
            .set({ refreshSecret: null })
            .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, owner)));
        }
        if (!accessTokenValid(row.expiresAt)) return { missing: true as const, system };
      }
    }
    return accessTokenValid(row.expiresAt)
      ? {
          credential: { header: 'authorization', value: `Bearer ${decryptCredential(row.secret)}` },
          revision: s.authRevision,
        }
      : { missing: true as const, system };
  });
}
