import { currentSystemSettings, loadPlatformConfig } from '@mcp/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServerInstances, mcpServers, userServerAccess, users } from '@/auth/infrastructure/database/schema.js';
import { bearerTokenMatches } from '@/shared/security/bearer.js';
import { createHash } from 'node:crypto';

/** Internal control-plane endpoint consumed by every gateway replica. */
export function createRegistryRouter(): Hono {
  const router = new Hono();
  const config = loadPlatformConfig();

  router.get('/internal/mcp-servers', async (c) => {
    if (
      !bearerTokenMatches(c.req.header('authorization'), process.env.INTERNAL_API_TOKEN ?? config.auth.internalApiToken)
    ) {
      return c.json({ error: 'invalid_internal_token' }, 401);
    }

    const servers = await db
      .select({
        name: mcpServers.name,
        displayName: mcpServers.displayName,
        authMode: mcpServers.authMode,
        routingMode: mcpServers.routingMode,
        monitoringLogsEnabled: mcpServers.monitoringLogsEnabled,
        perMinute: mcpServers.userRateLimitPerMinute,
        daily: mcpServers.userDailyQuota,
        concurrent: mcpServers.userMaxConcurrent,
      })
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true))
      .orderBy(mcpServers.name);

    const allInstances = await db
      .select({
        serverName: mcpServerInstances.serverName,
        id: mcpServerInstances.id,
        displayName: mcpServerInstances.displayName,
        url: mcpServerInstances.url,
        authMode: mcpServerInstances.authMode,
      })
      .from(mcpServerInstances)
      .where(eq(mcpServerInstances.enabled, true))
      .orderBy(mcpServerInstances.id);
    const grouped = new Map<string, typeof allInstances>();
    for (const instance of allInstances) {
      const group = grouped.get(instance.serverName) ?? [];
      group.push(instance);
      grouped.set(instance.serverName, group);
    }
    const result = servers.map(({ perMinute, daily, concurrent, ...server }) => {
      const instances = (grouped.get(server.name) ?? []).map(({ serverName: _parent, ...instance }) => instance);
      return {
        ...server,
        userLimits: { perMinute, daily, concurrent },
        instances,
        ...(server.routingMode === 'aggregate' ? { upstreams: instances } : {}),
      };
    });

    const payload = {
      servers: result.filter((server) => server.instances.length > 0),
      ...(process.env.SYSTEM_CONFIG_MODE !== 'file' ? { system_settings: currentSystemSettings() } : {}),
    };
    const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(payload);
  });

  // Recheck mutable authorization state so disabling a user or removing a grant
  // takes effect even when an already-issued access token has not expired.
  router.get('/internal/mcp-access', async (c) => {
    if (
      !bearerTokenMatches(c.req.header('authorization'), process.env.INTERNAL_API_TOKEN ?? config.auth.internalApiToken)
    ) {
      return c.json({ error: 'invalid_internal_token' }, 401);
    }
    c.header('Cache-Control', 'no-store');
    const userId = Number(c.req.query('user_id'));
    const authVersion = Number(c.req.query('auth_version') ?? '0');
    const serverName = c.req.query('server') ?? '';
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !Number.isSafeInteger(authVersion) ||
      authVersion < 0 ||
      !serverName
    )
      return c.json({ error: 'invalid_request' }, 400);
    const [user] = await db
      .select({ id: users.id, role: users.role, disabled: users.disabled, allServers: users.allServers })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.authVersion, authVersion)))
      .limit(1);
    const [server] = await db
      .select({ name: mcpServers.name, enabled: mcpServers.enabled })
      .from(mcpServers)
      .where(eq(mcpServers.name, serverName))
      .limit(1);
    if (!user || user.disabled || !server?.enabled) return c.json({ error: 'access_denied' }, 403);
    if (user.role !== 'admin' && !user.allServers) {
      const [grant] = await db
        .select({ userId: userServerAccess.userId })
        .from(userServerAccess)
        .where(and(eq(userServerAccess.userId, userId), eq(userServerAccess.serverName, serverName)))
        .limit(1);
      if (!grant) return c.json({ error: 'access_denied' }, 403);
    }
    return c.json({ allowed: true });
  });

  return router;
}
