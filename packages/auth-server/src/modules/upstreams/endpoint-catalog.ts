import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '../../infrastructure/database/client.js';
import {
  mcpServerInstances,
  mcpServers,
  upstreamCredentials,
  userServerAccess,
  users,
} from '../../infrastructure/database/schema.js';

/** 查询结果只投影业务状态；密钥和令牌不得进入 HTTP DTO。 */
export async function listEndpointCatalog() {
  const [{ value: wildcardUserCount }] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, 'user'), eq(users.allServers, true)));

  const rows = await db
    .select({
      name: mcpServers.name,
      routingMode: mcpServers.routingMode,
      displayName: mcpServers.displayName,
      description: mcpServers.description,
      enabled: mcpServers.enabled,
      signupAccess: mcpServers.signupAccess,
      authMode: mcpServers.authMode,
      apiKeyHeader: mcpServers.apiKeyHeader,
      apiKeyPrefix: mcpServers.apiKeyPrefix,
      systemApiKeyConfigured: sql<boolean>`${mcpServers.systemApiKey} IS NOT NULL`,
      oauthAuthorizeUrl: mcpServers.oauthAuthorizeUrl,
      oauthTokenUrl: mcpServers.oauthTokenUrl,
      oauthClientId: mcpServers.oauthClientId,
      oauthScopes: mcpServers.oauthScopes,
      oauthResource: mcpServers.oauthResource,
      oauthIssuer: mcpServers.oauthIssuer,
      oauthClientAuthMethod: mcpServers.oauthClientAuthMethod,
      oauthClientSecretConfigured: sql<boolean>`${mcpServers.oauthClientSecret} IS NOT NULL`,
      createdAt: mcpServers.createdAt,
      userCount: count(userServerAccess.userId),
    })
    .from(mcpServers)
    .leftJoin(userServerAccess, eq(userServerAccess.serverName, mcpServers.name))
    .groupBy(mcpServers.name)
    .orderBy(mcpServers.name);

  const serverDtos = await Promise.all(
    rows.map(async (row) => {
      const instances = await db
        .select()
        .from(mcpServerInstances)
        .where(eq(mcpServerInstances.serverName, row.name))
        .orderBy(mcpServerInstances.id);
      const systemConnections = await db
        .select({ instanceId: upstreamCredentials.instanceId })
        .from(upstreamCredentials)
        .where(eq(upstreamCredentials.owner, 'system'));
      return {
        name: row.name,
        routing_mode: row.routingMode,
        display_name: row.displayName,
        description: row.description,
        enabled: row.enabled,
        signup_access: row.signupAccess,
        auth_mode: row.authMode,
        api_key_header: row.apiKeyHeader,
        api_key_prefix: row.apiKeyPrefix,
        system_api_key_configured: row.systemApiKeyConfigured,
        oauth_authorize_url: row.oauthAuthorizeUrl,
        oauth_token_url: row.oauthTokenUrl,
        oauth_client_id: row.oauthClientId,
        oauth_scopes: row.oauthScopes,
        oauth_resource: row.oauthResource,
        oauth_issuer: row.oauthIssuer,
        oauth_client_auth_method: row.oauthClientAuthMethod,
        oauth_client_secret_configured: row.oauthClientSecretConfigured,
        user_count: Number(row.userCount) + Number(wildcardUserCount),
        created_at: row.createdAt,
        instances: instances.map((instance) => ({
          id: instance.id,
          url: instance.url,
          enabled: instance.enabled,
          display_name: instance.displayName,
          auth_mode: instance.authMode,
          api_key_header: instance.apiKeyHeader,
          api_key_prefix: instance.apiKeyPrefix,
          system_api_key_configured: Boolean(instance.systemApiKey),
          oauth_authorize_url: instance.oauthAuthorizeUrl,
          oauth_token_url: instance.oauthTokenUrl,
          oauth_client_id: instance.oauthClientId,
          oauth_client_secret_configured: Boolean(instance.oauthClientSecret),
          oauth_scopes: instance.oauthScopes,
          oauth_resource: instance.oauthResource,
          oauth_issuer: instance.oauthIssuer,
          oauth_client_auth_method: instance.oauthClientAuthMethod,
          system_oauth_connected: systemConnections.some((c) => c.instanceId === instance.id),
        })),
      };
    }),
  );
  return {
    servers: serverDtos,
  };
}
