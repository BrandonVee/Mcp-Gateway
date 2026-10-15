import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { connectionStatus } from '@/auth/modules/upstreams/connection-status.js';

/** Read only authorized owners and metadata; no encrypted credential needs to enter this query. */
export async function listUpstreamConnections(user: User) {
  const grants = await db
    .select({ name: userServerAccess.serverName })
    .from(userServerAccess)
    .where(eq(userServerAccess.userId, user.id));
  const names = grants.map((grant) => grant.name);
  if (user.role !== 'admin' && !user.allServers && !names.length) return { servers: [] };
  const parents = await db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.enabled, true),
        user.role === 'admin' || user.allServers ? undefined : inArray(mcpServers.name, names),
      ),
    );
  if (!parents.length) return { servers: [] };
  const parentMap = new Map(parents.map((parent) => [parent.name, parent]));
  const instances = await db
    .select()
    .from(mcpServerInstances)
    .where(
      and(
        eq(mcpServerInstances.enabled, true),
        inArray(
          mcpServerInstances.serverName,
          parents.map((parent) => parent.name),
        ),
      ),
    );
  const rows = instances.length
    ? await db
        .select({
          instanceId: upstreamCredentials.instanceId,
          owner: upstreamCredentials.owner,
          mode: upstreamCredentials.mode,
          expiresAt: upstreamCredentials.expiresAt,
          hasRefreshToken: sql<boolean>`${upstreamCredentials.refreshSecret} IS NOT NULL`,
          validationStatus: upstreamCredentials.validationStatus,
          validatedAt: upstreamCredentials.validatedAt,
        })
        .from(upstreamCredentials)
        .where(
          and(
            inArray(
              upstreamCredentials.instanceId,
              instances.map((instance) => instance.id),
            ),
            inArray(upstreamCredentials.owner, [ownerFor(false, user.id), 'system']),
          ),
        )
    : [];
  const linked = new Map(rows.map((row) => [JSON.stringify([row.instanceId, row.owner]), row]));
  const legacy = await db
    .select({
      serverName: userMcpCredentials.serverName,
      mode: userMcpCredentials.mode,
      expiresAt: userMcpCredentials.expiresAt,
      hasRefreshToken: sql<boolean>`${userMcpCredentials.refreshSecret} IS NOT NULL`,
      validationStatus: userMcpCredentials.validationStatus,
      validatedAt: userMcpCredentials.validatedAt,
    })
    .from(userMcpCredentials)
    .where(eq(userMcpCredentials.userId, user.id));
  const legacyMap = new Map(legacy.map((row) => [row.serverName, row]));
  return {
    servers: [
      ...instances
        .filter((instance) => parentMap.get(instance.serverName)?.routingMode === 'aggregate')
        .map((instance) => {
          const parent = parentMap.get(instance.serverName)!;
          const row = linked.get(
            JSON.stringify([instance.id, ownerFor(instance.authMode === 'system_oauth', user.id)]),
          );
          return {
            name: instance.id,
            endpoint_name: parent.name,
            endpoint_display_name: parent.displayName,
            display_name: instance.displayName || instance.id,
            description: parent.description,
            auth_mode: instance.authMode,
            connection_status: connectionStatus(instance.authMode, row),
            validated_at: row?.validatedAt ?? null,
          };
        }),
      ...parents
        .filter((parent) => parent.routingMode === 'pool')
        .map((parent) => {
          const row = legacyMap.get(parent.name);
          return {
            name: `endpoint:${parent.name}`,
            endpoint_name: parent.name,
            endpoint_display_name: parent.displayName,
            display_name: parent.displayName,
            description: parent.description,
            auth_mode: parent.authMode,
            connection_status: connectionStatus(parent.authMode, row),
            validated_at: row?.validatedAt ?? null,
          };
        }),
    ],
  };
}
