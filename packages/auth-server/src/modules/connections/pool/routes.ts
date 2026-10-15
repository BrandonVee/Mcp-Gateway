import { poolCallbackUrl, connectionPortalUrl } from '@/auth/modules/connections/redirects.js';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createPkceAuthorization } from '@/auth/shared/security/pkce.js';
import { db } from '@/auth/infrastructure/database/client.js';
import {
  mcpServers,
  oauthConnectionStates,
  userMcpCredentials,
  userServerAccess,
} from '@/auth/infrastructure/database/schema.js';
import { encryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { isValidApiKey } from '@/shared/security/credentials.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
import { exchangeOAuthToken, tokenExpiry } from '@/auth/modules/upstreams/token-exchange.js';
import { accessibleServer } from '@/auth/modules/connections/pool/service.js';
import { lockAccessibleConnection, revokeUserConnection } from '@/auth/modules/connections/lifecycle.js';
import { connectionStatus } from '@/auth/modules/upstreams/connection-status.js';
/** Pool-mode connection routes; parent middleware protects browser writes. */
export function registerPoolConnectionRoutes(router: Hono) {
  router.get('/me/servers', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const servers = await db
      .select({
        name: mcpServers.name,
        displayName: mcpServers.displayName,
        description: mcpServers.description,
        authMode: mcpServers.authMode,
      })
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true))
      .orderBy(mcpServers.name);
    const grants =
      user.role === 'admin' || user.allServers
        ? null
        : await db
            .select({ serverName: userServerAccess.serverName })
            .from(userServerAccess)
            .where(eq(userServerAccess.userId, user.id));
    const allowed = new Set(grants?.map((row) => row.serverName));
    const credentials = await db
      .select({
        serverName: userMcpCredentials.serverName,
        mode: userMcpCredentials.mode,
        expiresAt: userMcpCredentials.expiresAt,
        refreshSecret: userMcpCredentials.refreshSecret,
        validationStatus: userMcpCredentials.validationStatus,
      })
      .from(userMcpCredentials)
      .where(eq(userMcpCredentials.userId, user.id));
    const linked = new Map(credentials.map((row) => [row.serverName, row]));
    return c.json({
      servers: servers
        .filter((server) => user.role === 'admin' || user.allServers || allowed.has(server.name))
        .map((server) => {
          const credential = linked.get(server.name);
          return {
            name: server.name,
            display_name: server.displayName,
            description: server.description,
            auth_mode: server.authMode,
            connection_status: connectionStatus(
              server.authMode,
              credential ? { ...credential, hasRefreshToken: Boolean(credential.refreshSecret) } : undefined,
            ),
          };
        }),
    });
  });

  router.put('/me/servers/:name/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const server = await accessibleServer(user, c.req.param('name'));
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 404);
    if (server.authMode !== 'api_key') return c.json({ error: 'server_does_not_use_api_key' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { api_key?: unknown };
    const key = body?.api_key;
    if (!isValidApiKey(key)) return c.json({ error: 'invalid_api_key' }, 400);
    const now = Date.now();
    const secret = encryptCredential(key);
    const saved = await db.transaction(async (tx) => {
      const locked = await lockAccessibleConnection(tx, user.id, server.name, server.authRevision, user.authVersion);
      if (!locked || locked.authMode !== 'api_key') return false;
      await tx
        .insert(userMcpCredentials)
        .values({ userId: user.id, serverName: server.name, mode: 'api_key', secret, updatedAt: now })
        .onConflictDoUpdate({
          target: [userMcpCredentials.userId, userMcpCredentials.serverName],
          set: {
            mode: 'api_key',
            secret,
            refreshSecret: null,
            expiresAt: null,
            validationStatus: 'saved',
            validatedAt: null,
            updatedAt: now,
          },
        });
      return true;
    });
    if (!saved) return c.json({ error: 'server_changed_or_denied' }, 409);
    return c.json({ connection_status: 'saved' });
  });

  router.delete('/me/servers/:name/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const server = await accessibleServer(user, c.req.param('name'));
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 404);
    await revokeUserConnection(user.id, server.name);
    return c.json({ connection_status: 'not_connected' });
  });

  router.post('/me/servers/:name/oauth', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const server = await accessibleServer(user, c.req.param('name'));
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 404);
    if (server.authMode !== 'oauth' || !server.oauthAuthorizeUrl || !server.oauthClientId)
      return c.json({ error: 'oauth_not_configured' }, 400);
    // PKCE: the verifier stays in the database and never reaches the browser.
    const { state, verifier, challenge } = createPkceAuthorization();
    const started = await db.transaction(async (tx) => {
      const locked = await lockAccessibleConnection(tx, user.id, server.name, server.authRevision, user.authVersion);
      if (!locked || locked.authMode !== 'oauth') return false;
      // One pending flow per user and server: a retry replaces the state instead
      // of racing an older tab's callback.
      await tx
        .delete(oauthConnectionStates)
        .where(and(eq(oauthConnectionStates.userId, user.id), eq(oauthConnectionStates.serverName, server.name)));
      await tx.insert(oauthConnectionStates).values({
        state,
        userId: user.id,
        serverName: server.name,
        authRevision: locked.authRevision,
        verifier,
        expiresAt: Date.now() + 10 * 60_000,
      });
      return true;
    });
    if (!started) return c.json({ error: 'server_changed_or_denied' }, 409);
    const url = new URL(server.oauthAuthorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', server.oauthClientId);
    url.searchParams.set('redirect_uri', poolCallbackUrl(server.name));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (server.oauthScopes) url.searchParams.set('scope', server.oauthScopes);
    if (server.oauthResource) url.searchParams.set('resource', server.oauthResource);
    return c.json({ authorization_url: url.toString() });
  });

  // The callback is a browser redirect, so every failure is reported by
  // redirecting to the connections page with a result instead of a status code.
  router.get('/oauth/callback/:name', async (c) => {
    const state = c.req.query('state');
    const [saved] = state
      ? await db.select().from(oauthConnectionStates).where(eq(oauthConnectionStates.state, state)).limit(1)
      : [];
    if (!saved || saved.expiresAt < Date.now() || saved.serverName !== c.req.param('name'))
      return c.redirect(connectionPortalUrl('invalid_state', c.req.param('name')));
    const user = await currentUser(c);
    if (!user || user.id !== saved.userId) return c.redirect(connectionPortalUrl('session_expired', saved.serverName));
    const code = c.req.query('code');
    if (!code || c.req.query('error')) {
      await db.delete(oauthConnectionStates).where(eq(oauthConnectionStates.state, saved.state));
      return c.redirect(connectionPortalUrl('cancelled', saved.serverName));
    }
    const server = await accessibleServer(user, saved.serverName);
    if (!server || server.authMode !== 'oauth' || server.authRevision !== saved.authRevision)
      return c.redirect(connectionPortalUrl('unavailable', saved.serverName));
    if (server.oauthIssuer && c.req.query('iss') !== server.oauthIssuer)
      return c.redirect(connectionPortalUrl('issuer_mismatch', saved.serverName));
    const body = await exchangeOAuthToken(
      server,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: poolCallbackUrl(server.name),
        code_verifier: saved.verifier,
      }),
    ).catch(() => null);
    if (!body) return c.redirect(connectionPortalUrl('token_error', server.name));
    const refresh =
      typeof body.refresh_token === 'string' && body.refresh_token ? encryptCredential(body.refresh_token) : null;
    const now = Date.now();
    const secret = encryptCredential(body.access_token as string);
    const expiresAt = tokenExpiry(body);
    const connected = await db.transaction(async (tx) => {
      const locked = await lockAccessibleConnection(tx, user.id, server.name, saved.authRevision, user.authVersion);
      if (!locked || locked.authMode !== 'oauth') return false;
      const [pending] = await tx
        .select()
        .from(oauthConnectionStates)
        .where(eq(oauthConnectionStates.state, saved.state))
        .for('update')
        .limit(1);
      if (
        !pending ||
        pending.userId !== user.id ||
        pending.serverName !== locked.name ||
        pending.authRevision !== locked.authRevision ||
        pending.expiresAt <= Date.now()
      )
        return false;
      await tx.delete(oauthConnectionStates).where(eq(oauthConnectionStates.state, saved.state));
      await tx
        .insert(userMcpCredentials)
        .values({
          userId: user.id,
          serverName: server.name,
          mode: 'oauth',
          secret,
          refreshSecret: refresh,
          expiresAt,
          updatedAt: now,
          validationStatus: 'verified',
          validatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userMcpCredentials.userId, userMcpCredentials.serverName],
          set: {
            mode: 'oauth',
            validationStatus: 'verified',
            validatedAt: now,
            secret,
            refreshSecret: refresh,
            expiresAt,
            updatedAt: now,
          },
        });
      return true;
    });
    if (!connected) return c.redirect(connectionPortalUrl('invalid_state', server.name));
    return c.redirect(connectionPortalUrl('connected', server.name));
  });
}
