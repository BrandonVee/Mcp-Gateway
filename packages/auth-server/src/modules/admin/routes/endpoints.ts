import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../../infrastructure/database/client.js';
import {
  alertEvents,
  mcpServerInstances,
  mcpServers,
  oauthConnectionStates,
  userMcpCredentials,
} from '../../../infrastructure/database/schema.js';
import { jsonError } from '../../../shared/http/responses.js';
import { authSettings } from '../../upstreams/auth-settings.js';
import { listEndpointCatalog } from '../../upstreams/endpoint-catalog.js';
import { convertEndpointToGroup } from '../../upstreams/endpoint-groups.js';
import { validateMcpEndpoint } from '../../upstreams/endpoint-validation.js';
import type { AdminRouter } from '../context.js';
import { serverCreateSchema, serverPatchSchema } from '../validation.js';

/** 逻辑端点只管理分组、状态与访问策略。 */
export function registerEndpointsRoutes(router: AdminRouter) {
  router.get('/admin/servers', async (c) => {
    return c.json(await listEndpointCatalog());
  });

  router.post('/admin/servers', async (c) => {
    const parsed = serverCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return jsonError(c, parsed.error.issues[0]?.message ?? 'invalid server payload');
    const body = parsed.data;
    const name = body.name;
    const [existing] = await db
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
    if (existing) return jsonError(c, 'server already exists', 409);
    const displayName = body.display_name?.trim() || name;
    const description = body.description?.trim() ?? '';
    if (body.routing_mode === 'aggregate' && body.auth_mode !== undefined && body.auth_mode !== 'none')
      return jsonError(c, 'upstream_auth_required');
    const auth = authSettings(body as Record<string, unknown>);
    if (auth.error) return jsonError(c, auth.error);
    const now = Date.now();
    const requestedInstances = body.instances ?? [];
    const normalizedInstances: Array<{ id: string; url: string }> = [];
    for (const instance of requestedInstances) {
      const endpoint = validateMcpEndpoint(instance.url);
      if (endpoint.error) return c.json(endpoint, 400);
      normalizedInstances.push({ id: instance.id?.trim() || randomUUID(), url: endpoint.url });
    }
    try {
      await db.transaction(async (tx) => {
        await tx.insert(mcpServers).values({
          name,
          displayName,
          routingMode:
            body.routing_mode ??
            (requestedInstances.length || (body.auth_mode && body.auth_mode !== 'none') ? 'pool' : 'aggregate'),
          description,
          enabled: true,
          signupAccess: body.signup_access ?? false,
          createdAt: now,
          updatedAt: now,
          ...auth.values,
        });
        if (normalizedInstances.length) {
          await tx.insert(mcpServerInstances).values(
            normalizedInstances.map((instance) => ({
              ...instance,
              serverName: name,
              displayName: instance.id,
              ...auth.values,
              enabled: true,
              createdAt: now,
              updatedAt: now,
            })),
          );
        }
      });
    } catch (error) {
      const failure = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      if (failure.code === '23505' || failure.cause?.code === '23505')
        return jsonError(
          c,
          (failure.constraint ?? failure.cause?.constraint) === 'mcp_server_instances_pkey'
            ? 'instance_already_exists'
            : 'server already exists',
          409,
        );
      throw error;
    }
    return c.json(
      {
        name,
        display_name: displayName,
        description,
        enabled: true,
        signup_access: body.signup_access ?? false,
        auth_mode: auth.values?.authMode,
        instances: normalizedInstances,
      },
      201,
    );
  });

  router.patch('/admin/servers/:name', async (c) => {
    const name = c.req.param('name');
    const parsed = serverPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return jsonError(c, parsed.error.issues[0]?.message ?? 'invalid server payload');
    const body = parsed.data;
    const nextName = body.name ?? name;
    try {
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(mcpServers).where(eq(mcpServers.name, name)).for('update').limit(1);
        if (!existing) return { error: 'server not found', status: 404 as const };
        if (nextName !== name) {
          const [taken] = await tx
            .select({ name: mcpServers.name })
            .from(mcpServers)
            .where(eq(mcpServers.name, nextName))
            .limit(1);
          if (taken) return { error: 'server already exists', status: 409 as const };
        }
        const changes: Partial<typeof mcpServers.$inferInsert> = { name: nextName, updatedAt: Date.now() };
        let credentialsChanged = false;
        if (body.auth_mode !== undefined) {
          if (existing.routingMode === 'aggregate' && body.auth_mode !== 'none')
            return { error: 'upstream_auth_required', status: 400 as const };
          const auth = authSettings(body as Record<string, unknown>, existing);
          if (auth.error) return { error: auth.error, status: 400 as const };
          credentialsChanged = Boolean(
            auth.values &&
            (existing.authMode !== auth.values.authMode ||
              existing.systemApiKey !== auth.values.systemApiKey ||
              ((auth.values.authMode === 'api_key' || auth.values.authMode === 'system_api_key') &&
                (existing.apiKeyHeader !== auth.values.apiKeyHeader ||
                  existing.apiKeyPrefix !== auth.values.apiKeyPrefix)) ||
              (auth.values.authMode === 'oauth' &&
                (existing.oauthAuthorizeUrl !== auth.values.oauthAuthorizeUrl ||
                  existing.oauthTokenUrl !== auth.values.oauthTokenUrl ||
                  existing.oauthClientId !== auth.values.oauthClientId ||
                  existing.oauthClientSecret !== auth.values.oauthClientSecret ||
                  (existing.oauthScopes ?? '') !== (auth.values.oauthScopes ?? '') ||
                  existing.oauthResource !== auth.values.oauthResource ||
                  existing.oauthIssuer !== auth.values.oauthIssuer ||
                  existing.oauthClientAuthMethod !== auth.values.oauthClientAuthMethod))),
          );
          Object.assign(changes, auth.values);
        }
        if (body.routing_mode === 'aggregate' && existing.routingMode === 'pool') {
          await convertEndpointToGroup(tx, existing);
          changes.authRevision = existing.authRevision + 1;
        }
        if (body.routing_mode !== undefined) changes.routingMode = body.routing_mode;
        if (body.display_name !== undefined) changes.displayName = body.display_name.trim();
        if (body.description !== undefined) changes.description = body.description.trim();
        if (body.enabled !== undefined) changes.enabled = body.enabled;
        if (body.signup_access !== undefined) changes.signupAccess = body.signup_access;
        // Pending upstream OAuth callbacks still point at the old route.
        if (
          nextName !== name ||
          credentialsChanged ||
          (body.enabled !== undefined && body.enabled !== existing.enabled)
        ) {
          changes.authRevision = existing.authRevision + 1;
          await tx.delete(oauthConnectionStates).where(eq(oauthConnectionStates.serverName, name));
        }
        if (credentialsChanged) await tx.delete(userMcpCredentials).where(eq(userMcpCredentials.serverName, name));
        // ON UPDATE CASCADE retains instances, grants, and saved credentials.
        await tx.update(mcpServers).set(changes).where(eq(mcpServers.name, name));
        if (nextName !== name)
          await tx
            .update(alertEvents)
            .set({
              fingerprint: sql`concat(${nextName}::text, right(${alertEvents.fingerprint}::text, position(${'\x1f'}::text in ${alertEvents.fingerprint}::text)))`,
              server: nextName,
            })
            .where(eq(alertEvents.server, name));
        return { name: nextName };
      });
      if (result.error) return jsonError(c, result.error, result.status);
      return c.json({ ok: true, name: result.name });
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      if (failure.code === '23505' || failure.cause?.code === '23505')
        return jsonError(c, 'server already exists', 409);
      throw error;
    }
  });

  router.delete('/admin/servers/:name', async (c) => {
    const deleted = await db
      .delete(mcpServers)
      .where(eq(mcpServers.name, c.req.param('name')))
      .returning({ name: mcpServers.name });
    if (!deleted.length) return jsonError(c, 'server not found', 404);
    return c.json({ ok: true });
  });
}
