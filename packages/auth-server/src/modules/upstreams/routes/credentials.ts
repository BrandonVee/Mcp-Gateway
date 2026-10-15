import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '@/auth/infrastructure/database/client.js';
import { upstreamCredentials, upstreamOAuthStates } from '@/auth/infrastructure/database/schema.js';
import { encryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { isValidApiKey } from '@/shared/security/credentials.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
import { lockOwner, lockUpstream, ownerFor } from '@/auth/modules/upstreams/connection-service.js';
/** Registers credentials operations for concrete upstreams, with per-owner credential isolation. */
export function registerCredentialsRoutes(router: Hono) {
  router.put('/me/upstreams/:id/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const key = (await c.req.json().catch(() => ({}))).api_key;
    if (!isValidApiKey(key)) return c.json({ error: 'invalid_api_key' }, 400);
    const saved = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, c.req.param('id'), user);
      if (!locked || locked.upstream.authMode !== 'api_key') return false;
      const id = locked.upstream.id,
        owner = ownerFor(false, user.id);
      await lockOwner(tx, id, owner);
      const values = {
        userId: user.id,
        mode: 'api_key' as const,
        secret: encryptCredential(key),
        refreshSecret: null,
        expiresAt: null,
        validationStatus: 'saved' as const,
        validatedAt: null,
        updatedAt: Date.now(),
      };
      await tx
        .insert(upstreamCredentials)
        .values({ instanceId: id, owner, ...values })
        .onConflictDoUpdate({ target: [upstreamCredentials.instanceId, upstreamCredentials.owner], set: values });
      return true;
    });
    return saved ? c.json({ connection_status: 'saved' }) : c.json({ error: 'server_changed_or_denied' }, 409);
  });

  router.delete('/me/upstreams/:id/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const result = await db.transaction(async (tx) => {
      const locked = await lockUpstream(tx, c.req.param('id'), user);
      if (!locked) return false;
      const system = locked.upstream.authMode === 'system_oauth';
      if (system && user.role !== 'admin') return false;
      if (locked.upstream.authMode === 'system_api_key' || locked.upstream.authMode === 'none') return false;
      const owner = ownerFor(system, user.id);
      await lockOwner(tx, locked.upstream.id, owner);
      await tx
        .delete(upstreamCredentials)
        .where(and(eq(upstreamCredentials.instanceId, locked.upstream.id), eq(upstreamCredentials.owner, owner)));
      await tx
        .delete(upstreamOAuthStates)
        .where(
          and(
            eq(upstreamOAuthStates.instanceId, locked.upstream.id),
            eq(upstreamOAuthStates.system, system),
            ...(system ? [] : [eq(upstreamOAuthStates.userId, user.id)]),
          ),
        );
      return true;
    });
    return result
      ? c.json({ connection_status: 'not_connected' })
      : c.json({ error: 'server_not_found_or_denied' }, 403);
  });
}
