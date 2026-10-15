import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServerInstances, upstreamCredentials, userMcpCredentials } from '@/auth/infrastructure/database/schema.js';
import { credentialVersion, decryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { consumeRateLimit } from '@/auth/infrastructure/cache/rate-limit.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
import { lockUpstream, lockOwner, ownerFor } from '@/auth/modules/upstreams/connection-service.js';
import { lockAccessibleConnection } from '@/auth/modules/connections/lifecycle.js';
import { accessTokenValid } from '@/auth/modules/upstreams/token-exchange.js';
import { requestUpstreamTest } from '@/auth/modules/upstreams/connection-test.js';
import { recordCredentialValidation } from '@/auth/modules/upstreams/credential-validation.js';

/** User probes can only reach an authorized saved target, and never refresh or disclose credentials. */
export function registerValidationRoutes(router: Hono) {
  const test = async (c: Context) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    try {
      if (!(await consumeRateLimit('connection-test-user', String(user.id), 10, 60)))
        return c.json({ error: 'rate_limit_exceeded' }, 429, { 'Retry-After': '60' });
    } catch {
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    const id = c.req.param('id'),
      name = c.req.param('name');
    const probe = await db.transaction(async (tx) => {
      if (id) {
        const locked = await lockUpstream(tx, id, user);
        if (!locked) return null;
        const s = locked.upstream,
          system = s.authMode === 'system_oauth';
        if ((system && user.role !== 'admin') || !['api_key', 'oauth', 'system_oauth'].includes(s.authMode))
          return null;
        const owner = ownerFor(system, user.id);
        await lockOwner(tx, s.id, owner);
        const [row] = await tx
          .select()
          .from(upstreamCredentials)
          .where(and(eq(upstreamCredentials.instanceId, s.id), eq(upstreamCredentials.owner, owner)))
          .for('share');
        if (!row || !accessTokenValid(row.expiresAt)) return null;
        return {
          instance_id: s.id,
          upstream_url: s.url,
          credential_version: credentialVersion(row.secret),
          credential: {
            header: row.mode === 'api_key' ? s.apiKeyHeader : 'authorization',
            value: (row.mode === 'api_key' ? s.apiKeyPrefix : 'Bearer ') + decryptCredential(row.secret),
          },
        };
      }
      const s = await lockAccessibleConnection(tx, user.id, name ?? '', undefined, user.authVersion);
      if (!s || s.routingMode !== 'pool' || !['api_key', 'oauth'].includes(s.authMode)) return null;
      const [row] = await tx
        .select()
        .from(userMcpCredentials)
        .where(and(eq(userMcpCredentials.userId, user.id), eq(userMcpCredentials.serverName, s.name)))
        .for('share');
      const [instance] = await tx
        .select({ url: mcpServerInstances.url })
        .from(mcpServerInstances)
        .where(and(eq(mcpServerInstances.serverName, s.name), eq(mcpServerInstances.enabled, true)))
        .orderBy(mcpServerInstances.id)
        .limit(1);
      if (!row || !instance || !accessTokenValid(row.expiresAt)) return null;
      return {
        server: s.name,
        upstream_url: instance.url,
        credential_version: credentialVersion(row.secret),
        credential: {
          header: row.mode === 'api_key' ? s.apiKeyHeader : 'authorization',
          value: (row.mode === 'api_key' ? s.apiKeyPrefix : 'Bearer ') + decryptCredential(row.secret),
        },
      };
    });
    if (!probe) return c.json({ error: 'connection_required' }, 409);
    const result = await requestUpstreamTest(probe.upstream_url, undefined, probe.credential);
    if ('error' in result) return c.json(result, 400);
    if (result.ok || result.reason === 'auth_required' || result.reason === 'access_denied') {
      const updated = await recordCredentialValidation({
        ...probe,
        user_id: user.id,
        auth_version: user.authVersion,
        status: result.ok ? 'verified' : 'rejected',
      });
      if (!updated) return c.json({ error: 'server_changed_or_denied' }, 409);
    }
    return c.json(result);
  };
  router.post('/me/upstreams/:id/test-connection', test);
  router.post('/me/servers/:name/test-connection', test);
}
