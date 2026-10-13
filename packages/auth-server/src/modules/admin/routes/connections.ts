import { and, eq } from 'drizzle-orm';
import { db } from '../../../infrastructure/database/client.js';
import { LockNamespace, lockTransaction } from '../../../infrastructure/database/locks.js';
import {
  mcpServerInstances,
  mcpServers,
  upstreamCredentials,
  upstreamOAuthStates,
  userMcpCredentials,
} from '../../../infrastructure/database/schema.js';
import { jsonError } from '../../../shared/http/responses.js';
import { revokeUserConnection } from '../../connections/lifecycle.js';
import type { AdminRouter } from '../context.js';
import { SERVER_NAME_RE } from '../validation.js';
/** Registers connections routes under the shared administrator guard. */
export function registerConnectionsRoutes(router: AdminRouter) {
  /** Metadata only: never expose API keys, OAuth access tokens or refresh tokens. */
  router.get('/admin/connections', async (c) => {
    c.header('Cache-Control', 'no-store');
    const rows = await db
      .select({
        userId: userMcpCredentials.userId,
        serverName: userMcpCredentials.serverName,
        mode: userMcpCredentials.mode,
        expiresAt: userMcpCredentials.expiresAt,
        refreshSecret: userMcpCredentials.refreshSecret,
        updatedAt: userMcpCredentials.updatedAt,
      })
      .from(userMcpCredentials);
    const upstreamRows = await db
      .select({
        userId: upstreamCredentials.userId,
        instanceId: upstreamCredentials.instanceId,
        serverName: mcpServerInstances.serverName,
        mode: upstreamCredentials.mode,
        expiresAt: upstreamCredentials.expiresAt,
        refreshSecret: upstreamCredentials.refreshSecret,
        updatedAt: upstreamCredentials.updatedAt,
      })
      .from(upstreamCredentials)
      .innerJoin(mcpServerInstances, eq(mcpServerInstances.id, upstreamCredentials.instanceId))
      .innerJoin(mcpServers, eq(mcpServers.name, mcpServerInstances.serverName))
      .where(eq(mcpServers.routingMode, 'aggregate'));
    return c.json({
      connections: [
        ...upstreamRows
          .filter((row) => row.userId !== null)
          .map((row) => ({
            user_id: row.userId!,
            server_name: row.serverName,
            upstream_id: row.instanceId,
            mode: row.mode,
            expires_at: row.expiresAt,
            has_refresh_token: Boolean(row.refreshSecret),
            updated_at: row.updatedAt,
          })),
        ...rows.map((row) => ({
          user_id: row.userId,
          server_name: row.serverName,
          mode: row.mode,
          expires_at: row.expiresAt,
          has_refresh_token: Boolean(row.refreshSecret),
          updated_at: row.updatedAt,
        })),
      ],
    });
  });

  router.delete('/admin/connections/:userId/:serverName', async (c) => {
    const userId = Number(c.req.param('userId'));
    const serverName = c.req.param('serverName');
    if (!Number.isSafeInteger(userId) || userId <= 0 || !SERVER_NAME_RE.test(serverName))
      return jsonError(c, 'invalid connection identifier');
    if (!(await revokeUserConnection(userId, serverName))) return jsonError(c, 'connection not found', 404);
    return c.json({ ok: true });
  });

  router.delete('/admin/upstream-connections/:userId/:id', async (c) => {
    const userId = Number(c.req.param('userId')),
      id = c.req.param('id');
    if (!Number.isSafeInteger(userId) || userId <= 0) return jsonError(c, 'invalid connection identifier');
    await db.transaction(async (tx) => {
      const [s] = await tx.select().from(mcpServerInstances).where(eq(mcpServerInstances.id, id));
      if (!s) return;
      await tx.select().from(mcpServers).where(eq(mcpServers.name, s.serverName)).for('share');
      await tx.select().from(mcpServerInstances).where(eq(mcpServerInstances.id, id)).for('share');
      await lockTransaction(tx, LockNamespace.UpstreamCredential, `${id}:user:${userId}`);
      await tx
        .delete(upstreamCredentials)
        .where(and(eq(upstreamCredentials.instanceId, id), eq(upstreamCredentials.owner, `user:${userId}`)));
      await tx
        .delete(upstreamOAuthStates)
        .where(
          and(
            eq(upstreamOAuthStates.instanceId, id),
            eq(upstreamOAuthStates.userId, userId),
            eq(upstreamOAuthStates.system, false),
          ),
        );
    });
    return c.json({ ok: true });
  });
}
