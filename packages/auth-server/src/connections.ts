import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { loadPlatformConfig } from '@mcp/shared';
import { createLoginSession, db, deleteLoginSession, getSessionUser, verifyUser } from './db.js';
import { decryptCredential, encryptCredential } from './credential-crypto.js';
import { mcpServers, oauthConnectionStates, userMcpCredentials, userServerAccess, users } from './schema.js';

const config = loadPlatformConfig();
const issuer = config.auth.issuer.replace(/\/+$/, '');
const webUrl = process.env.ADMIN_WEB_URL ?? 'http://localhost:5173';
const cookieName = 'auth_session';
type User = { id: number; username: string; role: 'admin' | 'user'; allServers: boolean };

async function currentUser(c: Context): Promise<User | null> {
  const token = getCookie(c, cookieName);
  const session = token ? await getSessionUser(token) : null;
  if (!session) return null;
  const [user] = await db.select({ id: users.id, username: users.username, role: users.role, disabled: users.disabled, allServers: users.allServers })
    .from(users).where(eq(users.username, session.sub)).limit(1);
  return user && !user.disabled ? { id: user.id, username: user.username, role: user.role, allServers: user.allServers } : null;
}

async function accessibleServer(user: User, serverName: string) {
  const [server] = await db.select().from(mcpServers).where(and(eq(mcpServers.name, serverName), eq(mcpServers.enabled, true))).limit(1);
  if (!server) return null;
  if (user.role === 'admin' || user.allServers) return server;
  const [grant] = await db.select({ userId: userServerAccess.userId }).from(userServerAccess)
    .where(and(eq(userServerAccess.userId, user.id), eq(userServerAccess.serverName, serverName))).limit(1);
  return grant ? server : null;
}

function internalTokenMatches(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  if (!process.env.CREDENTIAL_BROKER_TOKEN) return false;
  const actual = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(process.env.CREDENTIAL_BROKER_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function callbackUrl(serverName: string): string {
  return `${issuer}/oauth/callback/${encodeURIComponent(serverName)}`;
}

function portalUrl(result: string, serverName: string): string {
  const url = new URL('/connections', webUrl);
  url.searchParams.set('result', result);
  url.searchParams.set('server', serverName);
  return url.toString();
}

async function exchangeOAuthToken(server: typeof mcpServers.$inferSelect, params: URLSearchParams): Promise<Record<string, unknown> | null> {
  if (!server.oauthTokenUrl || !server.oauthClientId) return null;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (server.oauthResource) params.set('resource', server.oauthResource);
  if (server.oauthClientAuthMethod === 'client_secret_basic' && server.oauthClientSecret) {
    const secret = decryptCredential(server.oauthClientSecret);
    const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
    headers.authorization = `Basic ${Buffer.from(`${formEncode(server.oauthClientId)}:${formEncode(secret)}`).toString('base64')}`;
  } else {
    params.set('client_id', server.oauthClientId);
    if (server.oauthClientAuthMethod === 'client_secret_post' && server.oauthClientSecret) {
      params.set('client_secret', decryptCredential(server.oauthClientSecret));
    }
  }
  const response = await fetch(server.oauthTokenUrl, { method: 'POST', headers, body: params, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (response.status >= 500) throw new Error(`upstream OAuth token endpoint HTTP ${response.status}`);
  if (!response.ok) return null;
  const body = await response.json() as Record<string, unknown>;
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer') return null;
  return typeof body.access_token === 'string' && body.access_token ? body : null;
}

function tokenExpiry(body: Record<string, unknown>): number | null {
  if (typeof body.expires_in !== 'number' && typeof body.expires_in !== 'string') return null;
  const seconds = Number(body.expires_in);
  return Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : null;
}

async function resolveCredential(userId: number, server: typeof mcpServers.$inferSelect): Promise<{ header: string; value: string } | null> {
  if (server.authMode === 'none') return null;
  if (server.authMode === 'api_key') {
    const [row] = await db.select().from(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name))).limit(1);
    if (!row || row.mode !== 'api_key') return null;
    return { header: server.apiKeyHeader, value: `${server.apiKeyPrefix}${decryptCredential(row.secret)}` };
  }

  // Serialize refreshes for one connection: a rotating refresh token must only be redeemed once.
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name)))
      .for('update').limit(1);
    if (!row || row.mode !== 'oauth') return null;
    if (!row.expiresAt || row.expiresAt > Date.now() + 60_000) {
      return { header: 'authorization', value: `Bearer ${decryptCredential(row.secret)}` };
    }
    if (!row.refreshSecret) return null;
    const refresh = decryptCredential(row.refreshSecret);
    const body = await exchangeOAuthToken(server, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }));
    if (!body) {
      await tx.update(userMcpCredentials).set({ refreshSecret: null, updatedAt: Date.now() })
        .where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name)));
      return null;
    }
    const nextRefresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : refresh;
    await tx.update(userMcpCredentials).set({
      secret: encryptCredential(body.access_token as string),
      refreshSecret: encryptCredential(nextRefresh),
      expiresAt: tokenExpiry(body),
      updatedAt: Date.now(),
    }).where(and(eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, server.name)));
    return { header: 'authorization', value: `Bearer ${body.access_token as string}` };
  });
}

export function createConnectionsRouter(): Hono {
  const router = new Hono();

  // Browser writes require a same-origin request. The Vite proxy uses the web origin.
  router.use('/me/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const accepted = [new URL(issuer).origin, new URL(webUrl).origin];
      if (origin && !accepted.includes(origin)) return c.json({ error: 'invalid_origin' }, 403);
    }
    await next();
  });

  router.get('/me/session', async (c) => {
    const user = await currentUser(c);
    return user ? c.json({ authenticated: true, username: user.username }) : c.json({ error: 'unauthorized' }, 401);
  });

  router.post('/me/session', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const user = typeof body.username === 'string' && typeof body.password === 'string'
      ? await verifyUser(body.username.trim(), body.password) : null;
    if (!user) return c.json({ error: 'invalid_credentials' }, 401);
    setCookie(c, cookieName, await createLoginSession(user.username), {
      httpOnly: true, sameSite: 'Lax', secure: issuer.startsWith('https://'), path: '/', maxAge: 7 * 24 * 3600,
    });
    return c.json({ authenticated: true, username: user.username });
  });

  router.delete('/me/session', async (c) => {
    const token = getCookie(c, cookieName);
    if (token) await deleteLoginSession(token);
    deleteCookie(c, cookieName, { path: '/' });
    return c.json({ authenticated: false });
  });

  router.get('/me/servers', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const servers = await db.select({ name: mcpServers.name, displayName: mcpServers.displayName, authMode: mcpServers.authMode })
      .from(mcpServers).where(eq(mcpServers.enabled, true)).orderBy(mcpServers.name);
    const grants = user.role === 'admin' || user.allServers ? null : await db.select({ serverName: userServerAccess.serverName })
      .from(userServerAccess).where(eq(userServerAccess.userId, user.id));
    const allowed = new Set(grants?.map((row) => row.serverName));
    const credentials = await db.select({ serverName: userMcpCredentials.serverName, mode: userMcpCredentials.mode, expiresAt: userMcpCredentials.expiresAt, refreshSecret: userMcpCredentials.refreshSecret })
      .from(userMcpCredentials).where(eq(userMcpCredentials.userId, user.id));
    const linked = new Map(credentials.map((row) => [row.serverName, row]));
    return c.json({ servers: servers.filter((server) => user.role === 'admin' || user.allServers || allowed.has(server.name))
      .map((server) => {
        const credential = linked.get(server.name);
        return { name: server.name, display_name: server.displayName, auth_mode: server.authMode,
          connection_status: server.authMode === 'none' ? 'not_required' : !credential || credential.mode !== server.authMode ? 'not_connected'
            : credential.expiresAt && credential.expiresAt <= Date.now() && !credential.refreshSecret ? 'expired' : 'connected' };
      }) });
  });

  router.put('/me/servers/:name/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const server = await accessibleServer(user, c.req.param('name'));
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 404);
    if (server.authMode !== 'api_key') return c.json({ error: 'server_does_not_use_api_key' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { api_key?: unknown };
    const key = body.api_key;
    if (typeof key !== 'string' || !key || key.length > 4096 || /[\x00-\x1f\x7f]/.test(key)) return c.json({ error: 'invalid_api_key' }, 400);
    const now = Date.now();
    const secret = encryptCredential(key);
    await db.insert(userMcpCredentials).values({ userId: user.id, serverName: server.name, mode: 'api_key', secret, updatedAt: now })
      .onConflictDoUpdate({ target: [userMcpCredentials.userId, userMcpCredentials.serverName], set: {
        mode: 'api_key', secret, refreshSecret: null, expiresAt: null, updatedAt: now,
      } });
    return c.json({ connection_status: 'connected' });
  });

  router.delete('/me/servers/:name/credential', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const server = await accessibleServer(user, c.req.param('name'));
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 404);
    await db.delete(userMcpCredentials).where(and(eq(userMcpCredentials.userId, user.id), eq(userMcpCredentials.serverName, server.name)));
    return c.json({ connection_status: 'not_connected' });
  });

  router.post('/me/servers/:name/oauth', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const server = await accessibleServer(user, c.req.param('name'));
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 404);
    if (server.authMode !== 'oauth' || !server.oauthAuthorizeUrl || !server.oauthClientId) return c.json({ error: 'oauth_not_configured' }, 400);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await db.insert(oauthConnectionStates).values({ state, userId: user.id, serverName: server.name, verifier, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL(server.oauthAuthorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', server.oauthClientId);
    url.searchParams.set('redirect_uri', callbackUrl(server.name));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (server.oauthScopes) url.searchParams.set('scope', server.oauthScopes);
    if (server.oauthResource) url.searchParams.set('resource', server.oauthResource);
    return c.json({ authorization_url: url.toString() });
  });

  router.get('/oauth/callback/:name', async (c) => {
    const state = c.req.query('state');
    const [saved] = state ? await db.delete(oauthConnectionStates).where(eq(oauthConnectionStates.state, state)).returning() : [];
    if (!saved || saved.expiresAt < Date.now() || saved.serverName !== c.req.param('name')) return c.redirect(portalUrl('invalid_state', c.req.param('name')));
    const user = await currentUser(c);
    if (!user || user.id !== saved.userId) return c.redirect(portalUrl('session_expired', saved.serverName));
    const code = c.req.query('code');
    if (!code || c.req.query('error')) return c.redirect(portalUrl('cancelled', saved.serverName));
    const server = await accessibleServer(user, saved.serverName);
    if (!server || server.authMode !== 'oauth') return c.redirect(portalUrl('unavailable', saved.serverName));
    if (server.oauthIssuer && c.req.query('iss') !== server.oauthIssuer) return c.redirect(portalUrl('issuer_mismatch', saved.serverName));
    const body = await exchangeOAuthToken(server, new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: callbackUrl(server.name), code_verifier: saved.verifier,
    })).catch(() => null);
    if (!body) return c.redirect(portalUrl('token_error', server.name));
    const refresh = typeof body.refresh_token === 'string' && body.refresh_token ? encryptCredential(body.refresh_token) : null;
    const now = Date.now();
    const secret = encryptCredential(body.access_token as string);
    const expiresAt = tokenExpiry(body);
    await db.insert(userMcpCredentials).values({ userId: user.id, serverName: server.name, mode: 'oauth',
      secret, refreshSecret: refresh, expiresAt, updatedAt: now })
      .onConflictDoUpdate({ target: [userMcpCredentials.userId, userMcpCredentials.serverName], set: {
        mode: 'oauth', secret, refreshSecret: refresh, expiresAt, updatedAt: now,
      } });
    return c.redirect(portalUrl('connected', server.name));
  });

  router.get('/internal/connector-credential', async (c) => {
    if (!internalTokenMatches(c.req.header('authorization'))) return c.json({ error: 'invalid_internal_token' }, 401);
    c.header('Cache-Control', 'no-store');
    const userId = Number(c.req.query('user_id'));
    const serverName = c.req.query('server') ?? '';
    if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ error: 'invalid_user' }, 400);
    const [row] = await db.select({ id: users.id, username: users.username, role: users.role, disabled: users.disabled, allServers: users.allServers })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (!row || row.disabled) return c.json({ error: 'user_unavailable' }, 403);
    const server = await accessibleServer({ id: row.id, username: row.username, role: row.role, allServers: row.allServers }, serverName);
    if (!server) return c.json({ error: 'server_not_found_or_denied' }, 403);
    if (server.authMode === 'none') return c.json({ error: 'credential_not_required' }, 400);
    const credential = await resolveCredential(userId, server);
    return credential ? c.json(credential) : c.json({ error: 'connection_required' }, 409);
  });

  return router;
}
