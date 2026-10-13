import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../../infrastructure/database/client.js';
import { users } from '../../../infrastructure/database/schema.js';
import { internalTokenMatches } from '../../../shared/security/internal-token.js';
import { accessibleServer, resolveCredential } from '../legacy-service.js';
/** Registers broker browser routes; write protection is applied by the parent router. */
export function registerBrokerRoutes(router: Hono) {
  // Gateway-internal: hands the upstream credential to a proxying Gateway that
  // presents a valid user token. Credentials are never exposed to browsers, and
  // auth_version must match so a revoked session cannot keep fetching them.
  router.get('/internal/connector-credential', async (c) => {
    if (!internalTokenMatches(c.req.header('authorization'))) return c.json({ error: 'invalid_internal_token' }, 401);
    c.header('Cache-Control', 'no-store');
    const userId = Number(c.req.query('user_id'));
    const serverName = c.req.query('server') ?? '';
    const version = c.req.query('auth_version') ?? '0';
    const authVersion = Number(version);
    if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ error: 'invalid_user' }, 400);
    if (!/^\d+$/.test(version) || !Number.isSafeInteger(authVersion)) return c.json({ error: 'user_unavailable' }, 403);
    const [row] = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        disabled: users.disabled,
        allServers: users.allServers,
        authVersion: users.authVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row || row.disabled || row.authVersion !== authVersion) return c.json({ error: 'user_unavailable' }, 403);
    const server = await accessibleServer(
      { id: row.id, username: row.username, role: row.role, allServers: row.allServers, authVersion: row.authVersion },
      serverName,
    );
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 403);
    if (server.authMode === 'none') return c.json({ error: 'credential_not_required' }, 400);
    let credential;
    try {
      credential = await resolveCredential(userId, server, authVersion);
    } catch {
      c.header('Retry-After', '5');
      return c.json({ error: 'credential_service_unavailable' }, 503);
    }
    return credential ? c.json(credential) : c.json({ error: 'connection_required' }, 409);
  });
}
