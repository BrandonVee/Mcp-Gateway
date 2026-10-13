/**
 * Pool-mode endpoints share one authentication configuration across their replicas.
 * Aggregate endpoints use modules/upstreams and independently scoped credentials.
 * Keep this path until persisted pools and their OAuth callbacks have been migrated.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServers, userMcpCredentials, userServerAccess } from '@/auth/infrastructure/database/schema.js';
import { decryptCredential, encryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import type { User } from '@/auth/modules/identity/session-user.js';
import {
  accessTokenValid,
  exchangeOAuthToken,
  OAuthTokenError,
  shouldRefresh,
  tokenExpiry,
} from '@/auth/modules/upstreams/token-exchange.js';
import { lockAccessibleConnection } from '@/auth/modules/connections/lifecycle.js';

export async function accessibleServer(
  user: Pick<User, 'id' | 'username' | 'role' | 'allServers' | 'authVersion'>,
  serverName: string,
) {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.name, serverName), eq(mcpServers.enabled, true)))
    .limit(1);
  if (!server) return null;
  if (user.role === 'admin' || user.allServers) return server;
  const [grant] = await db
    .select({ userId: userServerAccess.userId })
    .from(userServerAccess)
    .where(and(eq(userServerAccess.userId, user.id), eq(userServerAccess.serverName, serverName)))
    .limit(1);
  return grant ? server : null;
}

/**
 * Return the credential header for one upstream call, refreshing OAuth tokens
 * when needed. Everything runs under a row lock on the user's connection so two
 * concurrent requests cannot each refresh and leave the other holding a token
 * the upstream already rotated away.
 */
export async function resolveCredential(
  userId: number,
  snapshot: typeof mcpServers.$inferSelect,
  authVersion: number,
): Promise<{ header: string; value: string } | null> {
  return db.transaction(async (tx) => {
    const server = await lockAccessibleConnection(tx, userId, snapshot.name, snapshot.authRevision, authVersion);
    if (!server || server.authMode === 'none') return null;
    if (server.authMode === 'system_api_key')
      return server.systemApiKey
        ? { header: server.apiKeyHeader, value: `${server.apiKeyPrefix}${decryptCredential(server.systemApiKey)}` }
        : null;
    const [row] = await tx
      .select()
      .from(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name)))
      .for('update')
      .limit(1);
    if (!row || row.mode !== server.authMode) return null;
    if (server.authMode === 'api_key')
      return { header: server.apiKeyHeader, value: `${server.apiKeyPrefix}${decryptCredential(row.secret)}` };
    const access = () => ({ header: 'authorization', value: `Bearer ${decryptCredential(row.secret)}` });
    if (!shouldRefresh(row.expiresAt, Boolean(row.refreshSecret))) {
      return accessTokenValid(row.expiresAt) ? access() : null;
    }
    // A permanent refresh failure (revoked grant) drops the refresh token and
    // falls back to the access token if it is still valid; transient failures
    // keep the stored pair and let the next call retry.
    const refresh = decryptCredential(row.refreshSecret!);
    let body;
    try {
      body = await exchangeOAuthToken(
        server,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
      );
    } catch (error) {
      if (error instanceof OAuthTokenError && error.permanent) {
        await tx
          .update(userMcpCredentials)
          .set({ refreshSecret: null, updatedAt: Date.now() })
          .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name)));
        return accessTokenValid(row.expiresAt) ? access() : null;
      }
      if (accessTokenValid(row.expiresAt)) return access();
      throw error;
    }
    const nextRefresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : refresh;
    await tx
      .update(userMcpCredentials)
      .set({
        secret: encryptCredential(body.access_token),
        refreshSecret: encryptCredential(nextRefresh),
        expiresAt: tokenExpiry(body),
        updatedAt: Date.now(),
      })
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name)));
    return accessTokenValid(tokenExpiry(body))
      ? { header: 'authorization', value: `Bearer ${body.access_token}` }
      : null;
  });
}
