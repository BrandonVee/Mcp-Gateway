import { Hono } from 'hono';
import { internalTokenMatches } from '@/auth/shared/security/internal-token.js';
import { resolveUpstreamCredential } from '@/auth/modules/upstreams/connection-service.js';
/** Registers broker operations for concrete upstreams, with per-owner credential isolation. */
export function registerBrokerRoutes(router: Hono) {
  router.get('/internal/upstream-credential', async (c) => {
    if (!internalTokenMatches(c.req.header('authorization'))) return c.json({ error: 'invalid_internal_token' }, 401);
    c.header('Cache-Control', 'no-store');
    const id = Number(c.req.query('user_id')),
      version = Number(c.req.query('auth_version'));
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !/^\d+$/.test(c.req.query('auth_version') ?? '') ||
      !Number.isSafeInteger(version)
    )
      return c.json({ error: 'invalid_user' }, 400);
    const result = await resolveUpstreamCredential(
      c.req.query('instance_id') ?? '',
      { id, authVersion: version, role: 'user' },
      c.req.query('endpoint') ?? '',
      c.req.query('upstream_url') ?? '',
    );
    if ('configChanged' in result) return c.json({ error: 'upstream_config_changed' }, 503);
    if ('denied' in result) return c.json({ error: 'access_denied' }, 403);
    if ('missing' in result)
      return c.json(
        { error: result.system ? 'system_credential_unavailable' : 'connection_required' },
        result.system ? 503 : 409,
      );
    return c.json(result);
  });
}
