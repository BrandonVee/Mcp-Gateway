import { and, desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { loadPlatformConfig } from '@mcp/shared';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServers, userApiKeys } from '@/auth/infrastructure/database/schema.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
import { authenticateUserApiKey, createUserApiKey } from '@/auth/modules/identity/api-keys.js';
import { bearerTokenMatches } from '@/shared/security/bearer.js';

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\x00-\x1f\x7f]+$/),
});

export function registerApiKeyRoutes(router: Hono) {
  router.get('/me/api-keys', async (c) => {
    c.header('Cache-Control', 'no-store');
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const keys = await db
      .select({
        id: userApiKeys.id,
        name: userApiKeys.name,
        prefix: userApiKeys.prefix,
        created_at: userApiKeys.createdAt,
        last_used_at: userApiKeys.lastUsedAt,
      })
      .from(userApiKeys)
      .where(and(eq(userApiKeys.userId, user.id), eq(userApiKeys.userAuthVersion, user.authVersion)))
      .orderBy(desc(userApiKeys.createdAt));
    return c.json({ keys });
  });
  router.post('/me/api-keys', async (c) => {
    c.header('Cache-Control', 'no-store');
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_api_key_name' }, 400);
    const result = await createUserApiKey(user, parsed.data.name);
    if ('error' in result) return c.json(result, result.error === 'session_changed' ? 409 : 400);
    return c.json(result, 201);
  });
  router.delete('/me/api-keys/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const deleted = await db
      .delete(userApiKeys)
      .where(and(eq(userApiKeys.userId, user.id), eq(userApiKeys.id, c.req.param('id'))))
      .returning({ id: userApiKeys.id });
    return deleted.length ? c.json({ ok: true }) : c.json({ error: 'api_key_not_found' }, 404);
  });
  router.post('/internal/api-key-auth', async (c) => {
    const expected = process.env.INTERNAL_API_TOKEN ?? loadPlatformConfig().auth.internalApiToken;
    if (!bearerTokenMatches(c.req.header('authorization'), expected))
      return c.json({ error: 'invalid_internal_token' }, 401);
    c.header('Cache-Control', 'no-store');
    const body = await c.req.json().catch(() => null);
    if (typeof body?.key !== 'string') return c.json({ error: 'invalid_api_key' }, 401);
    const payload = await authenticateUserApiKey(body.key);
    if (!payload) return c.json({ error: 'invalid_api_key' }, 401);
    if (body.server !== undefined) {
      if (typeof body.server !== 'string') return c.json({ error: 'invalid_request' }, 400);
      const [server] = await db.select().from(mcpServers).where(eq(mcpServers.name, body.server)).limit(1);
      if (!server?.enabled || server.accessAuthMode !== 'api_key') return c.json({ error: 'access_denied' }, 403);
      if (payload.role !== 'admin' && !payload.mcp_servers.includes('*') && !payload.mcp_servers.includes(server.name))
        return c.json({ error: 'access_denied' }, 403);
    }
    return c.json({ payload });
  });
}
