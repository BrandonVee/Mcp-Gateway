import { upstreamTestAuthInputSchema } from '@mcp/shared';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/auth/infrastructure/database/client.js';
import {
  mcpServerInstances,
  mcpServers,
  upstreamCredentials,
  upstreamOAuthStates,
} from '@/auth/infrastructure/database/schema.js';
import { jsonError } from '@/auth/shared/http/responses.js';
import { authSettings } from '@/auth/modules/upstreams/auth-settings.js';
import { requestUpstreamTest } from '@/auth/modules/upstreams/connection-test.js';
import { convertEndpointToGroup } from '@/auth/modules/upstreams/endpoint-groups.js';
import { validateMcpEndpoint } from '@/auth/modules/upstreams/endpoint-validation.js';
import { resolveProbeCredential } from '@/auth/modules/upstreams/probe-credential.js';
import type { AdminRouter } from '@/auth/modules/admin/context.js';
import { instanceCreateSchema, instancePatchSchema } from '@/auth/modules/admin/validation.js';

/** 实际上游分别管理地址、认证和连接失效范围。 */
export function registerUpstreamsRoutes(router: AdminRouter) {
  router.post('/admin/servers/test-connection', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await c.req.json().catch(() => null);
    const endpoint = validateMcpEndpoint(body?.url);
    if (endpoint.error) return c.json(endpoint, 400);
    const parsedAuthentication = upstreamTestAuthInputSchema.safeParse(body);
    if (!parsedAuthentication.success) return jsonError(c, 'invalid_probe_credentials');
    const authentication = await resolveProbeCredential(parsedAuthentication.data, c.get('adminActor'));
    if ('error' in authentication)
      return jsonError(c, authentication.error, authentication.error === 'connection_required' ? 409 : 400);
    const result = await requestUpstreamTest(endpoint.url, undefined, authentication.credential);
    if ('error' in result) return c.json(result, 400);
    return c.json(result);
  });

  router.post('/admin/servers/:name/instances', async (c) => {
    const serverName = c.req.param('name');
    const [server] = await db
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(eq(mcpServers.name, serverName))
      .limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const parsed = instanceCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return jsonError(c, parsed.error.issues[0]?.message ?? 'invalid_instance_payload');
    const body = parsed.data;
    const endpoint = validateMcpEndpoint(body.url);
    if (endpoint.error) return c.json(endpoint, 400);
    const url = endpoint.url;
    const auth = authSettings(body);
    if (auth.error) return jsonError(c, auth.error);
    const id = body.id?.trim() || randomUUID();
    const now = Date.now();
    const inserted = await db
      .transaction(async (tx) => {
        const [parent] = await tx.select().from(mcpServers).where(eq(mcpServers.name, serverName)).for('update');
        if (!parent) return [];
        if (body.auth_mode !== undefined) await convertEndpointToGroup(tx, parent);
        const result = await tx
          .insert(mcpServerInstances)
          .values({
            id,
            serverName,
            url,
            displayName: body.display_name || id,
            ...auth.values,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: mcpServerInstances.id });
        if (!result.length) throw new Error('instance_already_exists');
        return result;
      })
      .catch((error) => {
        if (error instanceof Error && error.message === 'instance_already_exists') return [];
        throw error;
      });
    if (!inserted.length) return jsonError(c, 'instance_already_exists', 409);
    return c.json({ id, server_name: serverName, url, enabled: true }, 201);
  });

  router.patch('/admin/servers/:name/instances/:id', async (c) => {
    const { name, id } = c.req.param();
    const parsed = instancePatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return jsonError(c, parsed.error.issues[0]?.message ?? 'invalid_instance_payload');
    const body = parsed.data;
    const result = await db.transaction(async (tx) => {
      // Use the same parent -> upstream -> credential lock order as the broker.
      const [parent] = await tx.select().from(mcpServers).where(eq(mcpServers.name, name)).for('update');
      const [instance] = await tx
        .select()
        .from(mcpServerInstances)
        .where(and(eq(mcpServerInstances.id, id), eq(mcpServerInstances.serverName, name)))
        .for('update')
        .limit(1);
      if (!instance) return { error: 'server instance not found', status: 404 as const };
      const changes: Partial<typeof mcpServerInstances.$inferInsert> = { updatedAt: Date.now() };
      if (body.url !== undefined) {
        const endpoint = validateMcpEndpoint(body.url);
        if (endpoint.error) return { error: endpoint.error, status: 400 as const };
        changes.url = endpoint.url;
      }
      if (body.display_name !== undefined) changes.displayName = body.display_name;
      if (body.enabled !== undefined) changes.enabled = body.enabled;
      if (body.auth_mode !== undefined) {
        const auth = authSettings(body, parent?.routingMode === 'pool' ? parent : instance);
        if (auth.error) return { error: auth.error, status: 400 as const };
        Object.assign(changes, auth.values);
      }
      const authChanged = Object.keys(changes).some(
        (key) =>
          !['updatedAt', 'displayName'].includes(key) &&
          changes[key as keyof typeof changes] !== instance[key as keyof typeof instance],
      );
      if (parent && body.auth_mode !== undefined) await convertEndpointToGroup(tx, parent);
      if (authChanged) {
        changes.authRevision = instance.authRevision + 1;
        await tx.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.instanceId, id));
        await tx.delete(upstreamCredentials).where(eq(upstreamCredentials.instanceId, id));
      }
      await tx.update(mcpServerInstances).set(changes).where(eq(mcpServerInstances.id, id));
      return { status: 200 as const };
    });
    return 'error' in result ? jsonError(c, result.error!, result.status as 400 | 404) : c.json({ ok: true });
  });

  router.delete('/admin/servers/:name/instances/:id', async (c) => {
    const { name, id } = c.req.param();
    const deleted = await db
      .delete(mcpServerInstances)
      .where(and(eq(mcpServerInstances.id, id), eq(mcpServerInstances.serverName, name)))
      .returning({ id: mcpServerInstances.id });
    if (!deleted.length) return jsonError(c, 'server instance not found', 404);
    return c.json({ ok: true });
  });
}
