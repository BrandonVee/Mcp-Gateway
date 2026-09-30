import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import { createLoginSession, db, deleteLoginSession, getSessionUser, verifyUser } from './db.js';
import { scryptHash } from './users.js';
import type { SigningKeys } from './keys.js';
import type { Context as HonoContext } from 'hono';
import { and, count, desc, eq, lt } from 'drizzle-orm';
import { auditEvents, authCodes, loginSessions, mcpServerInstances, mcpServers, refreshTokens, userMcpCredentials, userServerAccess, users } from './schema.js';
import { randomUUID } from 'node:crypto';
import { normalizeUpstreamEndpoint, gatewayPublicUrl, adminWebUrl, databaseSettingsEnabled, systemConfigured, bootstrapOriginAllowed, normalizeSystemSettings, allowedUpstreamHosts, upstreamAllowlistEnabled } from '@mcp/shared';
import { encryptCredential } from './credential-crypto.js';
import { limitLoginAccount } from './rate-limit.js';
import { trustedAdminBearerClient } from './admin-bearer.js';
import { currentSystemSettings, saveSystemSettings } from './system-settings.js';

export interface AdminDeps {
  keys: SigningKeys;
  issuer: string;
}

const SERVER_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SESSION_COOKIE = 'auth_session';

function normalizeMcpEndpoint(value: string): string | null {
  try {
    const normalized = normalizeUpstreamEndpoint(value);
    if (!normalized) return null;
    const url = new URL(normalized);
    // A Gateway route is a client-facing URL, never an upstream instance.
    // Accepting it here creates a proxy loop and repeated OAuth challenges.
    const publicUrl = gatewayPublicUrl();
    if (publicUrl && url.origin === new URL(publicUrl).origin && /^\/mcp(?:\/|$)/.test(url.pathname)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function validOAuthUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    return false;
  }
}

function authSettings(body: Record<string, unknown>, existing?: typeof mcpServers.$inferSelect): { values?: Partial<typeof mcpServers.$inferInsert>; error?: string } {
  const mode = body.auth_mode ?? 'none';
  if (mode !== 'none' && mode !== 'api_key' && mode !== 'oauth') return { error: 'auth_mode must be none, api_key or oauth' };
  const values: Partial<typeof mcpServers.$inferInsert> = { authMode: mode };
  if (mode !== 'api_key') {
    values.apiKeyHeader = 'authorization';
    values.apiKeyPrefix = 'Bearer ';
  }
  if (mode !== 'oauth') {
    values.oauthAuthorizeUrl = null;
    values.oauthTokenUrl = null;
    values.oauthClientId = null;
    values.oauthClientSecret = null;
    values.oauthScopes = null;
    values.oauthResource = null;
    values.oauthIssuer = null;
    values.oauthClientAuthMethod = 'none';
  }
  if (mode === 'api_key') {
    const header = body.api_key_header ?? (existing?.authMode === 'api_key' ? existing.apiKeyHeader : 'authorization');
    const prefix = body.api_key_prefix ?? (existing?.authMode === 'api_key' ? existing.apiKeyPrefix : 'Bearer ');
    if (typeof header !== 'string' || !/^(authorization|x-[a-z0-9-]{1,60})$/i.test(header)) return { error: 'api_key_header must be authorization or an x-* header' };
    if (typeof prefix !== 'string' || prefix.length > 100 || /[\x00-\x1f\x7f]/.test(prefix)) return { error: 'invalid api_key_prefix' };
    values.apiKeyHeader = header.toLowerCase();
    values.apiKeyPrefix = prefix;
  }
  if (mode === 'oauth') {
    const authorizeUrl = body.oauth_authorize_url ?? existing?.oauthAuthorizeUrl;
    const tokenUrl = body.oauth_token_url ?? existing?.oauthTokenUrl;
    const clientId = body.oauth_client_id ?? existing?.oauthClientId;
    if (!validOAuthUrl(authorizeUrl) || !validOAuthUrl(tokenUrl)) return { error: 'valid OAuth authorize and token URLs are required' };
    if (typeof clientId !== 'string' || !clientId.trim()) return { error: 'oauth_client_id is required' };
    if (body.oauth_client_secret !== undefined && (typeof body.oauth_client_secret !== 'string' || body.oauth_client_secret.length > 4096)) return { error: 'invalid oauth_client_secret' };
    const clientAuthMethod = body.oauth_client_auth_method ?? existing?.oauthClientAuthMethod ?? (body.oauth_client_secret ? 'client_secret_basic' : 'none');
    if (clientAuthMethod !== 'none' && clientAuthMethod !== 'client_secret_basic' && clientAuthMethod !== 'client_secret_post') return { error: 'invalid oauth_client_auth_method' };
    if (clientAuthMethod !== 'none' && !body.oauth_client_secret && !existing?.oauthClientSecret) return { error: 'oauth_client_secret is required' };
    if (clientAuthMethod === 'none' && body.oauth_client_secret) return { error: 'oauth_client_secret requires a client authentication method' };
    if (body.oauth_scopes !== undefined && (typeof body.oauth_scopes !== 'string' || body.oauth_scopes.length > 1000)) return { error: 'invalid oauth_scopes' };
    if (body.oauth_resource !== undefined && body.oauth_resource !== '' && !validOAuthUrl(body.oauth_resource)) return { error: 'invalid oauth_resource' };
    if (body.oauth_issuer !== undefined && body.oauth_issuer !== '' && !validOAuthUrl(body.oauth_issuer)) return { error: 'invalid oauth_issuer' };
    values.oauthAuthorizeUrl = authorizeUrl;
    values.oauthTokenUrl = tokenUrl;
    values.oauthClientId = clientId.trim();
    values.oauthClientSecret = clientAuthMethod === 'none' ? null : body.oauth_client_secret ? encryptCredential(body.oauth_client_secret)
      : body.oauth_client_secret === undefined && existing?.authMode === 'oauth' ? existing.oauthClientSecret : null;
    values.oauthScopes = typeof body.oauth_scopes === 'string' ? body.oauth_scopes.trim() : existing?.oauthScopes ?? null;
    values.oauthResource = body.oauth_resource === '' ? null
      : typeof body.oauth_resource === 'string' ? body.oauth_resource : existing?.oauthResource ?? null;
    values.oauthIssuer = body.oauth_issuer === '' ? null
      : typeof body.oauth_issuer === 'string' ? body.oauth_issuer : existing?.oauthIssuer ?? null;
    values.oauthClientAuthMethod = clientAuthMethod;
  }
  return { values };
}

async function listServerNamesForUser(userId: number): Promise<string[]> {
  const rows = await db
    .select({ serverName: userServerAccess.serverName })
    .from(userServerAccess)
    .where(eq(userServerAccess.userId, userId))
    .orderBy(userServerAccess.serverName);
  return rows.map((row) => row.serverName);
}

async function replaceUserServers(userId: number, names: string[]): Promise<void> {
  const unique = [...new Set(names)];
  const allServers = unique.includes('*');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ allServers, updatedAt: Date.now() }).where(eq(users.id, userId));
    await tx.delete(userServerAccess).where(eq(userServerAccess.userId, userId));
    for (const name of allServers ? [] : unique) {
      await tx.insert(userServerAccess).values({ userId, serverName: name, createdAt: Date.now() });
    }
  });
}

async function getAdminActor(c: HonoContext, deps: AdminDeps): Promise<string | null> {
  const isActiveAdmin = async (username: string): Promise<boolean> => {
    const [row] = await db
      .select({ role: users.role, disabled: users.disabled })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return row?.role === 'admin' && !row.disabled;
  };
  // 1) Bearer JWT with role=admin
  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(header.slice(7).trim(), deps.keys.publicJwk, {
        issuer: deps.issuer,
        ...(process.env.NODE_ENV === 'production' ? { audience: `${deps.issuer}/admin` } : {}),
      });
      if (payload.role === 'admin' && typeof payload.sub === 'string'
        && trustedAdminBearerClient(payload.client_id) && (await isActiveAdmin(payload.sub))) return payload.sub;
    } catch {
      /* An invalid explicit credential must not fall back to a browser cookie. */
    }
    return null;
  }
  // 2) browser session cookie of an admin user
  const cookie = getCookie(c, 'auth_session');
  if (cookie) {
    const session = await getSessionUser(cookie);
    if (session && (await isActiveAdmin(session.sub))) return session.sub;
  }
  return null;
}

async function recordAudit(c: HonoContext, actor: string, statusCode: number): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      actor,
      method: c.req.method,
      path: c.req.path,
      statusCode,
      requestId: c.res.headers.get('x-request-id') ?? randomUUID(),
      createdAt: Date.now(),
    });
  } catch (error) {
    // A failed audit insert must be visible in runtime logs, even if the
    // already-executed admin operation cannot be rolled back here.
    console.error('[audit] insert failed', error);
  }
}

function jsonError(c: HonoContext, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: message }, status);
}

export function createAdminRouter(deps: AdminDeps): Hono {
  const router = new Hono();

  // Guard everything under /admin.
  router.use('/admin/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const allowed = !origin || (!systemConfigured()
        ? bootstrapOriginAllowed(origin, c.req.header('host'))
        : [deps.issuer, adminWebUrl()].map((url) => new URL(url).origin).includes(origin));
      if (!allowed) return jsonError(c, 'invalid_origin', 403);
    }
    if (c.req.path === '/admin' || c.req.path === '/admin/session') {
      await next();
      return;
    }
    const actor = await getAdminActor(c, deps);
    if (!actor) return jsonError(c, 'admin privileges required', 403);
    await next();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      await recordAudit(c, actor, c.res.status);
    }
  });

  router.get('/admin/session', async (c) => {
    const authenticated = Boolean(await getAdminActor(c, deps));
    return c.json({ authenticated }, authenticated ? 200 : 401);
  });

  router.post('/admin/session', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    if (typeof body.username === 'string' && body.username.trim()) {
      try {
        if (!(await limitLoginAccount(body.username))) {
          c.header('Retry-After', '900');
          return c.json({ error: 'rate_limit_exceeded' }, 429);
        }
      } catch {
        return c.json({ error: 'rate_limit_unavailable' }, 503);
      }
    }
    const user = body.username && body.password ? await verifyUser(body.username.trim(), body.password) : null;
    if (!user || user.role !== 'admin') {
      await recordAudit(c, typeof body.username === 'string' && SERVER_NAME_RE.test(body.username) ? body.username : 'anonymous', 401);
      return c.json({ error: 'invalid_admin_credentials' }, 401);
    }
    const token = await createLoginSession(user.username);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production' || deps.issuer.startsWith('https://'),
      path: '/',
      maxAge: 7 * 24 * 3600,
    });
    await recordAudit(c, user.username, 200);
    return c.json({ authenticated: true, username: user.username });
  });

  router.delete('/admin/session', async (c) => {
    const actor = await getAdminActor(c, deps);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteLoginSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    if (actor) await recordAudit(c, actor, 200);
    return c.json({ authenticated: false });
  });

  router.get('/admin/system-settings', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ managed: process.env.SYSTEM_CONFIG_MODE !== 'file', configured: systemConfigured(),
      ...(databaseSettingsEnabled() ? currentSystemSettings() : { public_url: deps.issuer,
        upstream_allowlist_enabled: upstreamAllowlistEnabled(), upstream_hosts: [...allowedUpstreamHosts()] }) });
  });
  router.put('/admin/system-settings', async (c) => {
    if (process.env.SYSTEM_CONFIG_MODE === 'file') return c.json({ error: 'system_settings_managed_by_environment' }, 409);
    const settings = normalizeSystemSettings(await c.req.json().catch(() => null));
    if (!settings) return c.json({ error: 'invalid_system_settings' }, 400);
    await saveSystemSettings(settings);
    return c.json({ managed: true, configured: true, ...settings });
  });

  /** Paginated, metadata-only admin audit stream. No request bodies or secrets. */
  router.get('/admin/audit-events', async (c) => {
    c.header('Cache-Control', 'no-store');
    const limit = c.req.query('limit') === undefined ? 50 : Number(c.req.query('limit'));
    const before = c.req.query('before') === undefined ? undefined : Number(c.req.query('before'));
    const actor = c.req.query('actor')?.trim();
    const method = c.req.query('method')?.trim().toUpperCase();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return jsonError(c, 'limit must be an integer from 1 to 100');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return jsonError(c, 'before must be a positive event ID');
    if (actor !== undefined && (actor.length < 1 || actor.length > 64)) return jsonError(c, 'actor must be 1-64 characters');
    if (method !== undefined && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return jsonError(c, 'invalid method');
    const rows = await db.select().from(auditEvents).where(and(
      before === undefined ? undefined : lt(auditEvents.id, before),
      actor === undefined ? undefined : eq(auditEvents.actor, actor),
      method === undefined ? undefined : eq(auditEvents.method, method),
    )).orderBy(desc(auditEvents.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({
      events: page.map((row) => ({
        id: row.id,
        actor: row.actor,
        method: row.method,
        path: row.path,
        status_code: row.statusCode,
        request_id: row.requestId,
        created_at: row.createdAt,
      })),
      next_before: rows.length > limit ? page[page.length - 1].id : null,
    });
  });

  router.get('/admin/users', async (c) => {
    const userRows = await db.select().from(users).orderBy(users.id);
    const userDtos = await Promise.all(userRows.map(async (u) => {
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        disabled: u.disabled,
        servers: u.role === 'admin' || u.allServers ? ['*'] : await listServerNamesForUser(u.id),
        created_at: u.createdAt,
      };
    }));
    return c.json({
      users: userDtos,
    });
  });

  router.post('/admin/users', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { username, password, role, servers } = body as { username?: string; password?: string; role?: string; servers?: unknown };
    if (!username || !/^[a-zA-Z0-9._-]{2,64}$/.test(username)) return jsonError(c, 'username must be 2-64 chars [a-zA-Z0-9._-]');
    if (!password || password.length < 12) return jsonError(c, 'password must be at least 12 characters');
    const userRole = role ?? 'user';
    if (userRole !== 'admin' && userRole !== 'user') return jsonError(c, 'role must be admin or user');
    if (servers !== undefined && (!Array.isArray(servers) || !servers.every((name) => typeof name === 'string'))) {
      return jsonError(c, 'servers must be an array of server names');
    }
    const requestedServers = [...new Set((servers ?? []) as string[])];
    if (requestedServers.includes('*') && requestedServers.length !== 1) return jsonError(c, 'wildcard must be the only server grant');
    for (const name of requestedServers) {
      if (name === '*') continue;
      const [server] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
      if (!SERVER_NAME_RE.test(name) || !server) {
        return jsonError(c, `unknown server: ${name}`);
      }
    }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) {
      return jsonError(c, 'username already exists', 409);
    }
    const now = Date.now();
    const [created] = await db
      .insert(users)
      .values({ username, passwordHash: scryptHash(password), role: userRole, disabled: false, createdAt: now, updatedAt: now })
      .returning({ id: users.id });
    const id = created.id;
    if (userRole !== 'admin') await replaceUserServers(id, requestedServers);
    return c.json({ id, username, role: userRole, disabled: false, servers: userRole === 'admin' ? ['*'] : requestedServers }, 201);
  });

  router.get('/admin/users/:id/servers', async (c) => {
    const id = Number(c.req.param('id'));
    const [row] = await db.select({ id: users.id, role: users.role, allServers: users.allServers }).from(users).where(eq(users.id, id)).limit(1);
    if (!row) return jsonError(c, 'user not found', 404);
    return c.json({ user_id: id, servers: row.role === 'admin' || row.allServers ? ['*'] : await listServerNamesForUser(id) });
  });

  /** Replace all grants for a user. This is the user <-> server many-to-many edge API. */
  router.put('/admin/users/:id/servers', async (c) => {
    const id = Number(c.req.param('id'));
    const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return jsonError(c, 'user not found', 404);
    if (user.role === 'admin') return jsonError(c, 'admins already have access to every server');
    const body = (await c.req.json().catch(() => ({}))) as { servers?: unknown };
    if (!Array.isArray(body.servers) || !body.servers.every((name) => typeof name === 'string')) {
      return jsonError(c, 'servers must be an array of server names');
    }
    const names = [...new Set(body.servers as string[])];
    if (names.includes('*') && names.length !== 1) return jsonError(c, 'wildcard must be the only server grant');
    for (const name of names) {
      if (name === '*') continue;
      const [server] = await db
        .select({ name: mcpServers.name })
        .from(mcpServers)
        .where(and(eq(mcpServers.name, name), eq(mcpServers.enabled, true)))
        .limit(1);
      if (!SERVER_NAME_RE.test(name) || !server) {
        return jsonError(c, `unknown or disabled server: ${name}`);
      }
    }
    await replaceUserServers(id, names);
    return c.json({ user_id: id, servers: names });
  });

  /** Server-centric view of the same user <-> server grants. Admins have implicit access. */
  router.get('/admin/servers/:name/users', async (c) => {
    const name = c.req.param('name');
    const [server] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const grants = await db.select({ userId: userServerAccess.userId }).from(userServerAccess)
      .where(eq(userServerAccess.serverName, name)).orderBy(userServerAccess.userId);
    return c.json({ server_name: name, user_ids: grants.map((grant) => grant.userId) });
  });

  router.put('/admin/servers/:name/users', async (c) => {
    const name = c.req.param('name');
    const [server] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { user_ids?: unknown };
    if (!Array.isArray(body.user_ids) || !body.user_ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return jsonError(c, 'user_ids must be an array of positive integer IDs');
    }
    const ids = [...new Set(body.user_ids as number[])];
    const candidates = await db.select({ id: users.id, role: users.role, allServers: users.allServers }).from(users);
    const ordinaryIds = new Set(candidates.filter((user) => user.role === 'user' && !user.allServers).map((user) => user.id));
    if (ids.some((id) => !ordinaryIds.has(id))) return jsonError(c, 'user_ids must refer to ordinary users without wildcard access');
    await db.transaction(async (tx) => {
      await tx.delete(userServerAccess).where(eq(userServerAccess.serverName, name));
      if (ids.length) await tx.insert(userServerAccess).values(ids.map((userId) => ({ userId, serverName: name, createdAt: Date.now() })));
    });
    return c.json({ server_name: name, user_ids: ids });
  });

  router.patch('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const [row] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, id)).limit(1);
    if (!row) return jsonError(c, 'user not found', 404);
    const body = await c.req.json().catch(() => ({}));
    const { password, role, disabled } = body as { password?: string; role?: string; disabled?: boolean };
    if (password !== undefined && (typeof password !== 'string' || password.length < 12)) return jsonError(c, 'password must be at least 12 characters');
    if (role !== undefined && role !== 'admin' && role !== 'user') return jsonError(c, 'role must be admin or user');
    if (disabled !== undefined && typeof disabled !== 'boolean') return jsonError(c, 'disabled must be a boolean');
    if (row.username === 'admin' && role !== undefined && role !== 'admin') return jsonError(c, 'cannot demote the bootstrap admin');
    if (row.username === 'admin' && disabled) return jsonError(c, 'cannot disable the bootstrap admin');
    if (password !== undefined) {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash: scryptHash(password), updatedAt: Date.now() }).where(eq(users.id, id));
        await tx.delete(loginSessions).where(eq(loginSessions.sub, row.username));
        await tx.delete(refreshTokens).where(eq(refreshTokens.sub, row.username));
        await tx.delete(authCodes).where(eq(authCodes.sub, row.username));
      });
    }
    if (role !== undefined) {
      await db.update(users).set({ role, updatedAt: Date.now() }).where(eq(users.id, id));
    }
    if (disabled !== undefined) {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ disabled, updatedAt: Date.now() }).where(eq(users.id, id));
        if (disabled) {
          await tx.delete(loginSessions).where(eq(loginSessions.sub, row.username));
          await tx.delete(refreshTokens).where(eq(refreshTokens.sub, row.username));
          await tx.delete(authCodes).where(eq(authCodes.sub, row.username));
        }
      });
    }
    return c.json({ ok: true });
  });

  router.delete('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const [row] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, id)).limit(1);
    if (!row) return jsonError(c, 'user not found', 404);
    if (row.username === 'admin') return jsonError(c, 'cannot delete the bootstrap admin');
    await db.delete(users).where(eq(users.id, id));
    return c.json({ ok: true });
  });

  /** Metadata only: never expose API keys, OAuth access tokens or refresh tokens. */
  router.get('/admin/connections', async (c) => {
    c.header('Cache-Control', 'no-store');
    const rows = await db.select({
      userId: userMcpCredentials.userId,
      serverName: userMcpCredentials.serverName,
      mode: userMcpCredentials.mode,
      expiresAt: userMcpCredentials.expiresAt,
      refreshSecret: userMcpCredentials.refreshSecret,
      updatedAt: userMcpCredentials.updatedAt,
    }).from(userMcpCredentials);
    return c.json({ connections: rows.map((row) => ({
      user_id: row.userId,
      server_name: row.serverName,
      mode: row.mode,
      expires_at: row.expiresAt,
      has_refresh_token: Boolean(row.refreshSecret),
      updated_at: row.updatedAt,
    })) });
  });

  router.delete('/admin/connections/:userId/:serverName', async (c) => {
    const userId = Number(c.req.param('userId'));
    const serverName = c.req.param('serverName');
    if (!Number.isSafeInteger(userId) || userId <= 0 || !SERVER_NAME_RE.test(serverName)) return jsonError(c, 'invalid connection identifier');
    const deleted = await db.delete(userMcpCredentials).where(and(
      eq(userMcpCredentials.userId, userId), eq(userMcpCredentials.serverName, serverName),
    )).returning({ userId: userMcpCredentials.userId });
    if (!deleted.length) return jsonError(c, 'connection not found', 404);
    return c.json({ ok: true });
  });

  router.get('/admin/servers', async (c) => {
    const [{ value: wildcardUserCount }] = await db.select({ value: count() }).from(users)
      .where(and(eq(users.role, 'user'), eq(users.allServers, true)));
    const rows = await db
      .select({
        name: mcpServers.name,
        displayName: mcpServers.displayName,
        enabled: mcpServers.enabled,
        authMode: mcpServers.authMode,
        apiKeyHeader: mcpServers.apiKeyHeader,
        apiKeyPrefix: mcpServers.apiKeyPrefix,
        oauthAuthorizeUrl: mcpServers.oauthAuthorizeUrl,
        oauthTokenUrl: mcpServers.oauthTokenUrl,
        oauthClientId: mcpServers.oauthClientId,
        oauthScopes: mcpServers.oauthScopes,
        oauthResource: mcpServers.oauthResource,
        oauthIssuer: mcpServers.oauthIssuer,
        oauthClientAuthMethod: mcpServers.oauthClientAuthMethod,
        createdAt: mcpServers.createdAt,
        userCount: count(userServerAccess.userId),
      })
      .from(mcpServers)
      .leftJoin(userServerAccess, eq(userServerAccess.serverName, mcpServers.name))
      .groupBy(mcpServers.name)
      .orderBy(mcpServers.name);
    const serverDtos = await Promise.all(rows.map(async (row) => {
      const instances = await db
        .select({ id: mcpServerInstances.id, url: mcpServerInstances.url, enabled: mcpServerInstances.enabled })
        .from(mcpServerInstances)
        .where(eq(mcpServerInstances.serverName, row.name))
        .orderBy(mcpServerInstances.id);
      return {
        name: row.name,
        display_name: row.displayName,
        enabled: row.enabled,
        auth_mode: row.authMode,
        api_key_header: row.apiKeyHeader,
        api_key_prefix: row.apiKeyPrefix,
        oauth_authorize_url: row.oauthAuthorizeUrl,
        oauth_token_url: row.oauthTokenUrl,
        oauth_client_id: row.oauthClientId,
        oauth_scopes: row.oauthScopes,
        oauth_resource: row.oauthResource,
        oauth_issuer: row.oauthIssuer,
        oauth_client_auth_method: row.oauthClientAuthMethod,
        user_count: Number(row.userCount) + Number(wildcardUserCount),
        created_at: row.createdAt,
        instances,
      };
    }));
    return c.json({
      servers: serverDtos,
    });
  });

  router.post('/admin/servers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      display_name?: string;
      instances?: Array<{ id?: string; url?: string }>;
      auth_mode?: string;
      api_key_header?: string;
      api_key_prefix?: string;
      oauth_authorize_url?: string;
      oauth_token_url?: string;
      oauth_client_id?: string;
      oauth_client_secret?: string;
      oauth_scopes?: string;
      oauth_resource?: string;
      oauth_issuer?: string;
      oauth_client_auth_method?: string;
    };
    const name = body.name?.trim() ?? '';
    if (!SERVER_NAME_RE.test(name)) return jsonError(c, 'name must be 1-64 chars [a-zA-Z0-9._-]');
    const [existing] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
    if (existing) return jsonError(c, 'server already exists', 409);
    const displayName = body.display_name?.trim() || name;
    const auth = authSettings(body as Record<string, unknown>);
    if (auth.error) return jsonError(c, auth.error);
    const now = Date.now();
    const requestedInstances = body.instances ?? [];
    const normalizedInstances: Array<{ id: string; url: string }> = [];
    for (const instance of requestedInstances) {
      const url = typeof instance.url === 'string' ? normalizeMcpEndpoint(instance.url) : null;
      if (!url) return jsonError(c, `invalid or gateway self-referential MCP endpoint URL: ${instance.url ?? ''}`);
      normalizedInstances.push({ id: instance.id?.trim() || randomUUID(), url });
    }
    await db.transaction(async (tx) => {
      await tx.insert(mcpServers).values({ name, displayName, enabled: true, createdAt: now, updatedAt: now, ...auth.values });
      if (normalizedInstances.length) {
        await tx.insert(mcpServerInstances).values(
          normalizedInstances.map((instance) => ({
            ...instance,
            serverName: name,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    });
    return c.json({ name, display_name: displayName, enabled: true, auth_mode: auth.values?.authMode, instances: normalizedInstances }, 201);
  });

  router.post('/admin/servers/:name/instances', async (c) => {
    const serverName = c.req.param('name');
    const [server] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.name, serverName)).limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; url?: string };
    const url = typeof body.url === 'string' ? normalizeMcpEndpoint(body.url) : null;
    if (!url) return jsonError(c, 'url must be an http(s) upstream MCP endpoint and must not point back to the Gateway');
    const id = body.id?.trim() || randomUUID();
    const now = Date.now();
    await db.insert(mcpServerInstances).values({ id, serverName, url, enabled: true, createdAt: now, updatedAt: now });
    return c.json({ id, server_name: serverName, url, enabled: true }, 201);
  });

  router.patch('/admin/servers/:name/instances/:id', async (c) => {
    const { name, id } = c.req.param();
    const [instance] = await db
      .select()
      .from(mcpServerInstances)
      .where(and(eq(mcpServerInstances.id, id), eq(mcpServerInstances.serverName, name)))
      .limit(1);
    if (!instance) return jsonError(c, 'server instance not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; enabled?: boolean };
    const changes: Partial<typeof mcpServerInstances.$inferInsert> = { updatedAt: Date.now() };
    if (body.url !== undefined) {
      const url = normalizeMcpEndpoint(body.url);
      if (!url) return jsonError(c, 'url must be an http(s) upstream MCP endpoint and must not point back to the Gateway');
      changes.url = url;
    }
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    await db.update(mcpServerInstances).set(changes).where(eq(mcpServerInstances.id, id));
    return c.json({ ok: true });
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

  router.patch('/admin/servers/:name', async (c) => {
    const name = c.req.param('name');
    const [existing] = await db.select().from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
    if (!existing) return jsonError(c, 'server not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { display_name?: string; enabled?: boolean; auth_mode?: string };
    if (body.auth_mode !== undefined) {
      const auth = authSettings(body as Record<string, unknown>, existing);
      if (auth.error) return jsonError(c, auth.error);
      const changed = auth.values && (
        existing.authMode !== auth.values.authMode ||
        (auth.values.authMode === 'api_key' && (existing.apiKeyHeader !== auth.values.apiKeyHeader || existing.apiKeyPrefix !== auth.values.apiKeyPrefix)) ||
        (auth.values.authMode === 'oauth' && (
          existing.oauthAuthorizeUrl !== auth.values.oauthAuthorizeUrl || existing.oauthTokenUrl !== auth.values.oauthTokenUrl ||
          existing.oauthClientId !== auth.values.oauthClientId || existing.oauthClientSecret !== auth.values.oauthClientSecret ||
          existing.oauthScopes !== auth.values.oauthScopes || existing.oauthResource !== auth.values.oauthResource ||
          existing.oauthIssuer !== auth.values.oauthIssuer || existing.oauthClientAuthMethod !== auth.values.oauthClientAuthMethod
        ))
      );
      await db.transaction(async (tx) => {
        await tx.update(mcpServers).set({ ...auth.values, updatedAt: Date.now() }).where(eq(mcpServers.name, name));
        if (changed) await tx.delete(userMcpCredentials).where(eq(userMcpCredentials.serverName, name));
      });
    }
    if (body.display_name !== undefined) {
      const displayName = body.display_name.trim();
      if (!displayName) return jsonError(c, 'display_name cannot be empty');
      await db.update(mcpServers).set({ displayName, updatedAt: Date.now() }).where(eq(mcpServers.name, name));
    }
    if (body.enabled !== undefined) {
      await db.update(mcpServers).set({ enabled: body.enabled, updatedAt: Date.now() }).where(eq(mcpServers.name, name));
    }
    return c.json({ ok: true });
  });

  router.delete('/admin/servers/:name', async (c) => {
    const deleted = await db.delete(mcpServers).where(eq(mcpServers.name, c.req.param('name'))).returning({ name: mcpServers.name });
    if (!deleted.length) return jsonError(c, 'server not found', 404);
    return c.json({ ok: true });
  });

  // Keep a single admin entry point. The React application owns login and UI rendering.
  router.get('/admin', (c) => c.redirect(adminWebUrl(), 302));

  return router;
}
