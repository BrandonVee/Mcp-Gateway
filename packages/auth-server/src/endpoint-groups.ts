import { eq, sql } from 'drizzle-orm';
import type { AuthTransaction } from './db.js';
import { mcpServers, mcpServerInstances, oauthConnectionStates, upstreamOAuthStates } from './schema.js';

/** Called with the endpoint locked: copy the latest legacy configuration exactly once. */
export async function convertEndpointToGroup(tx: AuthTransaction, parent: typeof mcpServers.$inferSelect) {
  if (parent.routingMode !== 'pool') return;
  const {
    authMode,
    apiKeyHeader,
    apiKeyPrefix,
    systemApiKey,
    oauthAuthorizeUrl,
    oauthTokenUrl,
    oauthClientId,
    oauthClientSecret,
    oauthScopes,
    oauthResource,
    oauthIssuer,
    oauthClientAuthMethod,
  } = parent;
  await tx
    .update(mcpServerInstances)
    .set({
      authMode,
      apiKeyHeader,
      apiKeyPrefix,
      systemApiKey,
      oauthAuthorizeUrl,
      oauthTokenUrl,
      oauthClientId,
      oauthClientSecret,
      oauthScopes,
      oauthResource,
      oauthIssuer,
      oauthClientAuthMethod,
      authRevision: parent.authRevision + 1,
    })
    .where(eq(mcpServerInstances.serverName, parent.name));
  await tx.execute(sql`INSERT INTO upstream_credentials (instance_id, owner, user_id, mode, secret, refresh_secret, expires_at, updated_at)
    SELECT i.id, concat('user:', c.user_id), c.user_id, c.mode, c.secret, c.refresh_secret, c.expires_at, c.updated_at
    FROM user_mcp_credentials c JOIN mcp_server_instances i ON i.server_name = c.server_name WHERE c.server_name = ${parent.name}
    ON CONFLICT (instance_id, owner) DO UPDATE SET mode = EXCLUDED.mode, secret = EXCLUDED.secret,
      refresh_secret = EXCLUDED.refresh_secret, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`);
  await tx.delete(oauthConnectionStates).where(eq(oauthConnectionStates.serverName, parent.name));
  await tx
    .delete(upstreamOAuthStates)
    .where(
      sql`${upstreamOAuthStates.instanceId} IN (SELECT id FROM mcp_server_instances WHERE server_name = ${parent.name})`,
    );
  await tx
    .update(mcpServers)
    .set({ routingMode: 'aggregate', authRevision: parent.authRevision + 1 })
    .where(eq(mcpServers.name, parent.name));
}
