import { eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import {
  mcpServerInstances,
  mcpServers,
  upstreamCredentials,
  userMcpCredentials,
  userServerAccess,
} from '@/auth/infrastructure/database/schema.js';
import type { User } from '@/auth/modules/identity/session-user.js';
import { ownerFor } from '@/auth/modules/upstreams/connection-service.js';
import { accessTokenValid } from '@/auth/modules/upstreams/token-exchange.js';
/** 查询结果只投影业务状态；密钥和令牌不得进入 HTTP DTO。 */
export async function listUpstreamConnections(user: User) {
  const parents = await db.select().from(mcpServers).where(eq(mcpServers.enabled, true));

  const grants = await db.select().from(userServerAccess).where(eq(userServerAccess.userId, user.id));

  const allowed = new Set(
    parents
      .filter((p) => user.role === 'admin' || user.allServers || grants.some((g) => g.serverName === p.name))
      .map((p) => p.name),
  );

  const instances = await db.select().from(mcpServerInstances).where(eq(mcpServerInstances.enabled, true));

  const rows = await db
    .select({
      instanceId: upstreamCredentials.instanceId,
      owner: upstreamCredentials.owner,
      mode: upstreamCredentials.mode,
      expiresAt: upstreamCredentials.expiresAt,
      refreshSecret: upstreamCredentials.refreshSecret,
    })
    .from(upstreamCredentials);

  const legacy = await db.select().from(userMcpCredentials).where(eq(userMcpCredentials.userId, user.id));
  return {
    servers: instances
      .filter(
        (s) => allowed.has(s.serverName) && parents.find((p) => p.name === s.serverName)?.routingMode === 'aggregate',
      )
      .map((s) => {
        const system = s.authMode === 'system_oauth';
        const row = rows.find((r) => r.instanceId === s.id && r.owner === ownerFor(system, user.id));
        const mode = s.authMode === 'api_key' ? 'api_key' : 'oauth';
        const status =
          s.authMode === 'none' || s.authMode === 'system_api_key'
            ? 'not_required'
            : !row || row.mode !== mode
              ? 'not_connected'
              : !accessTokenValid(row.expiresAt) && !row.refreshSecret
                ? 'expired'
                : 'connected';
        const parent = parents.find((p) => p.name === s.serverName)!;
        return {
          name: s.id,
          endpoint_name: parent.name,
          endpoint_display_name: parent.displayName,
          display_name: s.displayName || s.id,
          description: parent.description,
          auth_mode: s.authMode,
          connection_status: status,
        };
      })
      .concat(
        parents
          .filter((p) => p.routingMode === 'pool' && allowed.has(p.name))
          .map((p) => {
            const row = legacy.find((r) => r.serverName === p.name);
            return {
              name: `endpoint:${p.name}`,
              endpoint_name: p.name,
              endpoint_display_name: p.displayName,
              display_name: p.displayName,
              description: p.description,
              auth_mode: p.authMode,
              connection_status:
                p.authMode === 'none' || p.authMode === 'system_api_key'
                  ? 'not_required'
                  : !row || row.mode !== p.authMode
                    ? 'not_connected'
                    : !accessTokenValid(row.expiresAt) && !row.refreshSecret
                      ? 'expired'
                      : 'connected',
            };
          }),
      ),
  };
}
