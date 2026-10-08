import { canReuseSmtpPassword, smtpTestConfigSchema } from './smtp-config.js';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import {
  createLoginSession,
  db,
  deleteLoginSession,
  getSessionUser,
  revokeUserAuthentication,
  verifyUser,
} from './db.js';
import { scryptHash } from './users.js';
import type { SigningKeys } from './keys.js';
import type { Context as HonoContext } from 'hono';
import { and, count, desc, eq, lt, sql } from 'drizzle-orm';
import {
  auditEvents,
  alertEvents,
  mcpServerInstances,
  mcpServers,
  oauthConnectionStates,
  userMcpCredentials,
  userServerAccess,
  users,
} from './schema.js';
import { randomUUID } from 'node:crypto';
import {
  normalizeUpstreamHost,
  adminWebUrl,
  databaseSettingsEnabled,
  systemConfigured,
  bootstrapOriginAllowed,
  normalizeSystemSettings,
  allowedUpstreamHosts,
  upstreamAllowlistEnabled,
} from '@mcp/shared';
import { decryptCredential, encryptCredential } from './credential-crypto.js';
import { DockerError, getUpdateStatus, getUpdateTaskStatus, startUpdate, updateEnabled } from './system-update.js';
import { limitLoginAccount } from './rate-limit.js';
import { trustedAdminBearerClient } from './admin-bearer.js';
import { addUpstreamHost, currentSystemSettings, saveSystemSettings } from './system-settings.js';
import { validateMcpEndpoint } from './upstream-endpoint.js';
import { systemOptionDefaults, registrationEnabled, normalizeEmail, smtpConfigured } from '@mcp/shared';
import { mailConfigured, sendMail, sendMailWithSettings } from './mailer.js';
import { registerMonitoringRoutes } from './monitoring-api.js';
import { registerTopologyRoutes } from './topology-api.js';
import { revokeUserConnection } from './connection-lifecycle.js';
import { requestUpstreamTest } from './upstream-test.js';

export interface AdminDeps {
  keys: SigningKeys;
  issuer: string;
}

const SERVER_NAME_RE = /^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,64}$/;
const SESSION_COOKIE = 'auth_session';

// Request bodies are parsed once per route instead of field by field. The auth_*
// fields are validated later by authSettings(), so they stay on the parsed body.
const NAME_MESSAGE = 'name must be 1-64 chars [a-zA-Z0-9._-]';
const DESCRIPTION_MESSAGE = 'description must be a string of at most 2000 characters';
const serverName = z
  .string({ required_error: NAME_MESSAGE, invalid_type_error: NAME_MESSAGE })
  .trim()
  .regex(SERVER_NAME_RE, NAME_MESSAGE);
const serverDescription = z.string({ invalid_type_error: DESCRIPTION_MESSAGE }).max(2000, DESCRIPTION_MESSAGE);
const signupAccess = z.boolean({ invalid_type_error: 'signup_access must be a boolean' });
const userCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .max(254)
    .refine((value) => Boolean(normalizeEmail(value)), 'invalid_email'),
  password: z.string().min(12, 'invalid_password').max(256, 'invalid_password'),
  role: z.enum(['admin', 'user']).default('user'),
  email: z.string().trim().max(254, 'invalid_email').optional(),
  servers: z.array(z.string()).optional(),
});
const instanceId = z
  .string({ invalid_type_error: 'invalid_instance_payload' })
  .trim()
  .max(256, 'invalid_instance_payload');
const instanceCreateSchema = z.object({
  id: instanceId.optional(),
  url: z.string({ required_error: 'invalid_upstream_endpoint', invalid_type_error: 'invalid_upstream_endpoint' }),
});
const instancePatchSchema = z.object({
  url: z.string({ invalid_type_error: 'invalid_upstream_endpoint' }).optional(),
  enabled: z.boolean({ invalid_type_error: 'invalid_instance_payload' }).optional(),
});
const serverCreateSchema = z
  .object({
    name: serverName,
    display_name: z.string({ invalid_type_error: 'display_name must be a string' }).optional(),
    description: serverDescription.optional(),
    signup_access: signupAccess.optional(),
    instances: z.array(instanceCreateSchema).optional(),
  })
  .passthrough();
const serverPatchSchema = z
  .object({
    name: serverName.optional(),
    display_name: z
      .string({ invalid_type_error: 'display_name must be a non-empty string' })
      .trim()
      .min(1, 'display_name must be a non-empty string')
      .optional(),
    description: serverDescription.optional(),
    enabled: z.boolean({ invalid_type_error: 'enabled must be a boolean' }).optional(),
    signup_access: signupAccess.optional(),
  })
  .passthrough();

function validOAuthUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function authSettings(
  body: Record<string, unknown>,
  existing?: typeof mcpServers.$inferSelect,
): { values?: Partial<typeof mcpServers.$inferInsert>; error?: string } {
  const mode = body.auth_mode ?? 'none';
  if (mode !== 'none' && mode !== 'api_key' && mode !== 'oauth')
    return { error: 'auth_mode must be none, api_key or oauth' };
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
    if (typeof header !== 'string' || !/^(authorization|x-[a-z0-9-]{1,60})$/i.test(header))
      return { error: 'api_key_header must be authorization or an x-* header' };
    if (typeof prefix !== 'string' || prefix.length > 100 || /[\x00-\x1f\x7f]/.test(prefix))
      return { error: 'invalid api_key_prefix' };
    values.apiKeyHeader = header.toLowerCase();
    values.apiKeyPrefix = prefix;
  }
  if (mode === 'oauth') {
    const authorizeUrl = body.oauth_authorize_url ?? existing?.oauthAuthorizeUrl;
    const tokenUrl = body.oauth_token_url ?? existing?.oauthTokenUrl;
    const clientId = body.oauth_client_id ?? existing?.oauthClientId;
    if (!validOAuthUrl(authorizeUrl) || !validOAuthUrl(tokenUrl))
      return { error: 'valid OAuth authorize and token URLs are required' };
    if (typeof clientId !== 'string' || !clientId.trim()) return { error: 'oauth_client_id is required' };
    if (
      body.oauth_client_secret !== undefined &&
      (typeof body.oauth_client_secret !== 'string' || body.oauth_client_secret.length > 4096)
    )
      return { error: 'invalid oauth_client_secret' };
    const clientAuthMethod =
      body.oauth_client_auth_method ??
      existing?.oauthClientAuthMethod ??
      (body.oauth_client_secret ? 'client_secret_basic' : 'none');
    if (
      clientAuthMethod !== 'none' &&
      clientAuthMethod !== 'client_secret_basic' &&
      clientAuthMethod !== 'client_secret_post'
    )
      return { error: 'invalid oauth_client_auth_method' };
    if (clientAuthMethod !== 'none' && !body.oauth_client_secret && !existing?.oauthClientSecret)
      return { error: 'oauth_client_secret is required' };
    if (clientAuthMethod === 'none' && body.oauth_client_secret)
      return { error: 'oauth_client_secret requires a client authentication method' };
    if (body.oauth_scopes !== undefined && (typeof body.oauth_scopes !== 'string' || body.oauth_scopes.length > 1000))
      return { error: 'invalid oauth_scopes' };
    if (body.oauth_resource !== undefined && body.oauth_resource !== '' && !validOAuthUrl(body.oauth_resource))
      return { error: 'invalid oauth_resource' };
    if (body.oauth_issuer !== undefined && body.oauth_issuer !== '' && !validOAuthUrl(body.oauth_issuer))
      return { error: 'invalid oauth_issuer' };
    values.oauthAuthorizeUrl = authorizeUrl;
    values.oauthTokenUrl = tokenUrl;
    values.oauthClientId = clientId.trim();
    values.oauthClientSecret =
      clientAuthMethod === 'none'
        ? null
        : body.oauth_client_secret
          ? encryptCredential(body.oauth_client_secret)
          : body.oauth_client_secret === undefined && existing?.authMode === 'oauth'
            ? existing.oauthClientSecret
            : null;
    values.oauthScopes =
      typeof body.oauth_scopes === 'string' ? body.oauth_scopes.trim() || null : (existing?.oauthScopes ?? null);
    values.oauthResource =
      body.oauth_resource === ''
        ? null
        : typeof body.oauth_resource === 'string'
          ? body.oauth_resource
          : (existing?.oauthResource ?? null);
    values.oauthIssuer =
      body.oauth_issuer === ''
        ? null
        : typeof body.oauth_issuer === 'string'
          ? body.oauth_issuer
          : (existing?.oauthIssuer ?? null);
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
  const isActiveAdmin = async (userId: unknown, username: string, authVersion: unknown): Promise<boolean> => {
    if (
      typeof userId !== 'number' ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      typeof authVersion !== 'number' ||
      !Number.isSafeInteger(authVersion) ||
      authVersion < 0
    )
      return false;
    const [row] = await db
      .select({ role: users.role, disabled: users.disabled })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.username, username), eq(users.authVersion, authVersion)))
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
      if (
        payload.role === 'admin' &&
        typeof payload.sub === 'string' &&
        trustedAdminBearerClient(payload.client_id) &&
        (await isActiveAdmin(payload.uid, payload.sub, payload.auth_version ?? 0))
      )
        return payload.sub;
    } catch {
      /* An invalid explicit credential must not fall back to a browser cookie. */
    }
    return null;
  }
  // 2) browser session cookie of an admin user
  const cookie = getCookie(c, 'auth_session');
  if (cookie) {
    const session = await getSessionUser(cookie);
    if (session && (await isActiveAdmin(session.userId, session.sub, session.userAuthVersion))) return session.sub;
  }
  return null;
}

export async function recordAudit(c: HonoContext, actor: string, statusCode: number): Promise<void> {
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
      const allowed =
        !origin ||
        (!systemConfigured()
          ? bootstrapOriginAllowed(origin, c.req.header('host'))
          : [deps.issuer, adminWebUrl()].map((url) => new URL(url).origin).includes(origin));
      if (!allowed) return jsonError(c, 'invalid_origin', 403);
      const expectedIdentity = c.req.header('x-session-identity');
      const login = c.req.method === 'POST' && c.req.path === '/admin/session';
      if (!login && expectedIdentity !== undefined && !c.req.header('authorization')?.startsWith('Bearer ')) {
        const cookie = getCookie(c, SESSION_COOKIE);
        const session = cookie ? await getSessionUser(cookie) : null;
        const expiredLogout = !session && c.req.method === 'DELETE' && c.req.path === '/admin/session';
        if (!expiredLogout && (!session || expectedIdentity !== `${session.userId}:${session.userAuthVersion}`)) {
          return jsonError(c, 'session_changed', 409);
        }
      }
    }
    if (c.req.path === '/admin' || c.req.path === '/admin/session') {
      await next();
      return;
    }
    const actor = await getAdminActor(c, deps);
    if (!actor) return jsonError(c, 'admin privileges required', 403);
    (c as unknown as { set(key: string, value: string): void }).set('adminActor', actor);
    await next();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      await recordAudit(c, actor, c.res.status);
    }
  });

  registerMonitoringRoutes(router);
  registerTopologyRoutes(router);

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
    const user =
      typeof body.username === 'string' && typeof body.password === 'string'
        ? await verifyUser(body.username.trim(), body.password)
        : null;
    if (!user || user.role !== 'admin') {
      await recordAudit(
        c,
        typeof body.username === 'string' && SERVER_NAME_RE.test(body.username) ? body.username : 'anonymous',
        401,
      );
      return c.json({ error: 'invalid_admin_credentials' }, 401);
    }
    let token: string;
    try {
      token = await createLoginSession(user.id, user.authVersion);
    } catch {
      return c.json({ error: 'invalid_admin_credentials' }, 401);
    }
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
    const stored = databaseSettingsEnabled()
      ? currentSystemSettings()
      : {
          public_url: deps.issuer,
          upstream_allowlist_enabled: upstreamAllowlistEnabled(),
          upstream_hosts: [...allowedUpstreamHosts()],
        };
    // The stored password is an encrypted envelope; browsers only learn whether one exists.
    const { smtp_password: configuredPassword, ...visible } = {
      ...systemOptionDefaults,
      registration_enabled: registrationEnabled(),
      ...stored,
    };
    return c.json({
      managed: process.env.SYSTEM_CONFIG_MODE !== 'file',
      configured: systemConfigured(),
      public_url_requires_https: process.env.NODE_ENV === 'production',
      ...visible,
      smtp_password: '',
      smtp_password_configured: Boolean(configuredPassword),
    });
  });
  router.put('/admin/system-settings', async (c) => {
    if (process.env.SYSTEM_CONFIG_MODE === 'file')
      return c.json({ error: 'system_settings_managed_by_environment' }, 409);
    const raw = await c.req.json().catch(() => null);
    const settings = normalizeSystemSettings(raw);
    if (!settings) return c.json({ error: 'invalid_system_settings' }, 400);
    if (settings.registration_email_verification && !smtpConfigured({ ...currentSystemSettings(), ...settings }))
      return c.json({ error: 'verification_unavailable' }, 400);
    // Password semantics: a non-empty value replaces the stored secret, an empty
    // string clears it, and an absent field keeps the current envelope.
    const plaintext =
      raw && typeof raw === 'object' && typeof (raw as { smtp_password?: unknown }).smtp_password === 'string'
        ? ((raw as { smtp_password: string }).smtp_password as string)
        : undefined;
    settings.smtp_password =
      plaintext === undefined
        ? (currentSystemSettings().smtp_password ?? '')
        : plaintext
          ? encryptCredential(plaintext)
          : '';
    await saveSystemSettings(settings);
    return c.json({
      managed: true,
      configured: true,
      public_url_requires_https: process.env.NODE_ENV === 'production',
      ...systemOptionDefaults,
      ...settings,
      smtp_password: '',
      smtp_password_configured: Boolean(settings.smtp_password),
    });
  });

  /** Test a transient SMTP draft or the saved relay without changing configuration. */
  router.post('/admin/system-settings/test-email', async (c) => {
    const body = await c.req.json().catch(() => null);
    const to = normalizeEmail((body as { to?: unknown } | null)?.to);
    if (!to) return c.json({ error: 'invalid_email' }, 400);
    const smtp = (body as { smtp?: unknown } | null)?.smtp;
    const parsed = smtp === undefined ? null : smtpTestConfigSchema.safeParse(smtp);
    if (parsed && !parsed.success) return c.json({ error: 'invalid_smtp_settings' }, 400);
    if (!parsed && !mailConfigured()) return c.json({ error: 'smtp_not_configured' }, 409);
    const subject = 'MCP Gateway SMTP 测试 / SMTP test';
    const text =
      '这是一封测试邮件，说明 SMTP 配置可以发送邮件。\nThis test message confirms your SMTP configuration works.';
    try {
      if (parsed?.success) {
        const saved = currentSystemSettings();
        const config = parsed.data;
        if (
          config.smtp_username &&
          config.smtp_password === undefined &&
          saved.smtp_password &&
          !canReuseSmtpPassword(config, saved)
        )
          return c.json({ error: 'smtp_test_password_required' }, 400);
        // A blank form password retains the stored envelope; explicit empty clears it for this test.
        const password =
          config.smtp_password === undefined
            ? config.smtp_username && saved.smtp_password
              ? decryptCredential(saved.smtp_password)
              : ''
            : config.smtp_password;
        await sendMailWithSettings({ ...saved, ...config }, password, to, subject, text);
      } else {
        await sendMail(to, subject, text);
      }
      return c.json({ ok: true });
    } catch (error) {
      console.error('[smtp] test email failed', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: 'smtp_send_failed' }, 502);
    }
  });

  router.post('/admin/system-settings/upstream-hosts', async (c) => {
    if (process.env.SYSTEM_CONFIG_MODE === 'file')
      return c.json({ error: 'system_settings_managed_by_environment' }, 409);
    const body = await c.req.json().catch(() => null);
    const host = normalizeUpstreamHost(body?.host);
    if (!host) return c.json({ error: 'invalid_upstream_host' }, 400);
    if (!systemConfigured()) return c.json({ error: 'system_settings_required' }, 409);
    const settings = await addUpstreamHost(host);
    if (!settings) return c.json({ error: 'upstream_host_limit_reached' }, 400);
    return c.json({
      managed: true,
      configured: true,
      public_url_requires_https: process.env.NODE_ENV === 'production',
      ...systemOptionDefaults,
      ...settings,
    });
  });

  router.get('/admin/system-update', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!updateEnabled()) return c.json({ error: 'system_update_disabled' }, 503);
    return c.json(
      await getUpdateStatus(process.env, c.req.query('check') === 'true', c.req.query('runtime') === 'true'),
    );
  });

  router.get('/admin/system-update/tasks/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!updateEnabled()) return c.json({ error: 'system_update_disabled' }, 503);
    try {
      return c.json(await getUpdateTaskStatus(c.req.param('id')));
    } catch (error) {
      return c.json(
        { error: error instanceof DockerError ? error.message : 'system_update_failed' },
        error instanceof DockerError && error.status === 400 ? 400 : 503,
      );
    }
  });

  router.post('/admin/system-update', async (c) => {
    if (!updateEnabled()) return c.json({ error: 'system_update_disabled' }, 503);
    try {
      // Returns as soon as the updater container exists: pulling the image
      // happens there, well past the proxy's response timeout.
      const body = await c.req.json().catch(() => null);
      const parsed = z
        .object({ tag: z.string().max(64).optional() })
        .strict()
        .safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_update_version' }, 400);
      return c.json(await startUpdate(process.env, parsed.data.tag ?? 'latest'), 202);
    } catch (error) {
      if (error instanceof DockerError) return c.json({ error: error.message }, error.status as 400 | 409 | 503);
      return c.json({ error: 'system_update_failed' }, 503);
    }
  });

  /** Paginated, metadata-only admin audit stream. No request bodies or secrets. */
  router.get('/admin/audit-events', async (c) => {
    c.header('Cache-Control', 'no-store');
    const limit = c.req.query('limit') === undefined ? 50 : Number(c.req.query('limit'));
    const before = c.req.query('before') === undefined ? undefined : Number(c.req.query('before'));
    const actor = c.req.query('actor')?.trim();
    const method = c.req.query('method')?.trim().toUpperCase();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return jsonError(c, 'limit must be an integer from 1 to 100');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      return jsonError(c, 'before must be a positive event ID');
    if (actor !== undefined && (actor.length < 1 || actor.length > 64))
      return jsonError(c, 'actor must be 1-64 characters');
    if (method !== undefined && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      return jsonError(c, 'invalid method');
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          before === undefined ? undefined : lt(auditEvents.id, before),
          actor === undefined ? undefined : eq(auditEvents.actor, actor),
          method === undefined ? undefined : eq(auditEvents.method, method),
        ),
      )
      .orderBy(desc(auditEvents.id))
      .limit(limit + 1);
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
    const activeAdminCount = userRows.filter((user) => user.role === 'admin' && !user.disabled).length;
    const userDtos = await Promise.all(
      userRows.map(async (u) => {
        const protectedAdmin = u.role === 'admin' && !u.disabled && activeAdminCount <= 1;
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          email: u.email,
          email_verified: u.emailVerified,
          disabled: u.disabled,
          can_disable: !protectedAdmin,
          can_delete: !protectedAdmin,
          servers: u.role === 'admin' || u.allServers ? ['*'] : await listServerNamesForUser(u.id),
          created_at: u.createdAt,
        };
      }),
    );
    return c.json({
      users: userDtos,
    });
  });

  router.post('/admin/users', async (c) => {
    const parsed = userCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return jsonError(
        c,
        field === 'username' ? 'invalid_username' : field === 'password' ? 'invalid_password' : 'invalid_user_payload',
      );
    }
    const { username: rawUsername, password, role: userRole, servers } = parsed.data;
    const username = normalizeEmail(rawUsername)!;
    const rawEmail = username;
    const email = rawEmail === undefined || rawEmail === '' ? null : normalizeEmail(rawEmail);
    if (rawEmail !== undefined && rawEmail !== '' && !email) return jsonError(c, 'invalid_email');
    const requestedServers = userRole === 'admin' ? [] : [...new Set(servers ?? [])];
    if (requestedServers.includes('*') && requestedServers.length !== 1)
      return jsonError(c, 'wildcard must be the only server grant');
    for (const name of requestedServers) {
      if (name === '*') continue;
      const [server] = await db
        .select({ name: mcpServers.name })
        .from(mcpServers)
        .where(eq(mcpServers.name, name))
        .limit(1);
      if (!SERVER_NAME_RE.test(name) || !server) {
        return c.json({ error: 'unknown_server', server: name }, 400);
      }
    }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) {
      return jsonError(c, 'username already exists', 409);
    }
    if (email) {
      const [emailOwner] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (emailOwner) return jsonError(c, 'email already exists', 409);
    }
    const now = Date.now();
    const created = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          username,
          passwordHash: scryptHash(password),
          role: userRole,
          email,
          emailVerified: false,
          allServers: userRole !== 'admin' && requestedServers.includes('*'),
          disabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: users.username })
        .returning({ id: users.id });
      if (!created) return null;
      if (userRole !== 'admin' && !requestedServers.includes('*') && requestedServers.length)
        await tx
          .insert(userServerAccess)
          .values(requestedServers.map((serverName) => ({ userId: created.id, serverName, createdAt: now })));
      return created;
    });
    if (!created) return jsonError(c, 'username already exists', 409);
    const id = created.id;
    return c.json(
      {
        id,
        username,
        role: userRole,
        email,
        email_verified: false,
        disabled: false,
        servers: userRole === 'admin' ? ['*'] : requestedServers,
      },
      201,
    );
  });

  router.get('/admin/users/:id/servers', async (c) => {
    const id = Number(c.req.param('id'));
    const [row] = await db
      .select({ id: users.id, role: users.role, allServers: users.allServers })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row) return jsonError(c, 'user not found', 404);
    return c.json({
      user_id: id,
      servers: row.role === 'admin' || row.allServers ? ['*'] : await listServerNamesForUser(id),
    });
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
        .where(eq(mcpServers.name, name))
        .limit(1);
      if (!SERVER_NAME_RE.test(name) || !server) {
        return c.json({ error: 'unknown_server', server: name }, 400);
      }
    }
    await replaceUserServers(id, names);
    return c.json({ user_id: id, servers: names });
  });

  /** Server-centric view of the same user <-> server grants. Admins have implicit access. */
  router.get('/admin/servers/:name/users', async (c) => {
    const name = c.req.param('name');
    const [server] = await db
      .select({ name: mcpServers.name, signupAccess: mcpServers.signupAccess })
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const grants = await db
      .select({ userId: userServerAccess.userId })
      .from(userServerAccess)
      .where(eq(userServerAccess.serverName, name))
      .orderBy(userServerAccess.userId);
    return c.json({
      server_name: name,
      signup_access: server.signupAccess,
      user_ids: grants.map((grant) => grant.userId),
    });
  });

  router.put('/admin/servers/:name/users', async (c) => {
    const name = c.req.param('name');
    const [server] = await db
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { user_ids?: unknown; signup_access?: unknown };
    if (body.signup_access !== undefined && typeof body.signup_access !== 'boolean')
      return jsonError(c, 'signup_access must be a boolean');
    if (!Array.isArray(body.user_ids) || !body.user_ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return jsonError(c, 'user_ids must be an array of positive integer IDs');
    }
    const ids = [...new Set(body.user_ids as number[])];
    const candidates = await db.select({ id: users.id, role: users.role, allServers: users.allServers }).from(users);
    const ordinaryIds = new Set(
      candidates.filter((user) => user.role === 'user' && !user.allServers).map((user) => user.id),
    );
    if (ids.some((id) => !ordinaryIds.has(id)))
      return jsonError(c, 'user_ids must refer to ordinary users without wildcard access');
    await db.transaction(async (tx) => {
      if (typeof body.signup_access === 'boolean')
        await tx
          .update(mcpServers)
          .set({ signupAccess: body.signup_access, updatedAt: Date.now() })
          .where(eq(mcpServers.name, name));
      await tx.delete(userServerAccess).where(eq(userServerAccess.serverName, name));
      if (ids.length)
        await tx
          .insert(userServerAccess)
          .values(ids.map((userId) => ({ userId, serverName: name, createdAt: Date.now() })));
    });
    return c.json({ server_name: name, signup_access: body.signup_access, user_ids: ids });
  });

  router.patch('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return jsonError(c, 'invalid user ID');
    const body = await c.req.json().catch(() => ({}));
    const { password, role, disabled, username, email, email_verified } = body as {
      password?: string;
      role?: string;
      disabled?: boolean;
      username?: string;
      email?: string | null;
      email_verified?: boolean;
    };
    if (password !== undefined && (typeof password !== 'string' || password.length < 12 || password.length > 256))
      return jsonError(c, 'password must be 12-256 characters');
    if (role !== undefined && role !== 'admin' && role !== 'user') return jsonError(c, 'role must be admin or user');
    if (disabled !== undefined && typeof disabled !== 'boolean') return jsonError(c, 'disabled must be a boolean');
    if (
      username !== undefined &&
      (typeof username !== 'string' || (!normalizeEmail(username) && !/^[a-zA-Z0-9._-]{2,64}$/.test(username.trim())))
    )
      return jsonError(c, 'invalid_username');
    // null or '' clears the address; anything else must be a valid email.
    let nextEmail = email === undefined ? undefined : email === null || email === '' ? null : normalizeEmail(email);
    if (email !== undefined && email !== null && email !== '' && nextEmail === null)
      return jsonError(c, 'invalid_email');
    if (email_verified !== undefined && typeof email_verified !== 'boolean')
      return jsonError(c, 'email_verified must be a boolean');
    const passwordHash = password === undefined ? undefined : scryptHash(password);
    const result = await db.transaction(async (tx) => {
      // Serialize all administrator lifecycle changes with bootstrap across replicas.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(762441, 2)`);
      const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
      if (!row) return 'missing';
      const requestedName = username === undefined ? row.username : username.trim();
      const accountEmail = normalizeEmail(requestedName);
      if (accountEmail) {
        // Email accounts have one identity field; reject contradictory updates.
        if (nextEmail !== undefined && nextEmail !== accountEmail) return 'invalid_email';
        nextEmail = accountEmail;
      }
      const nextUsername = accountEmail ?? requestedName;
      const nextRole = role ?? row.role;
      const nextDisabled = disabled ?? row.disabled;
      if (row.role === 'admin' && !row.disabled && (nextRole !== 'admin' || nextDisabled)) {
        const [{ value }] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
        if (value <= 1) return 'last_admin';
      }
      if (nextUsername !== row.username) {
        const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.username, nextUsername)).limit(1);
        if (taken) return 'username_taken';
      }
      const emailChanged = nextEmail !== undefined && nextEmail !== row.email;
      if (emailChanged && nextEmail !== null && nextEmail !== undefined) {
        const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, nextEmail)).limit(1);
        if (taken) return 'email_taken';
      }
      const revoke =
        passwordHash !== undefined ||
        (disabled === true && !row.disabled) ||
        nextRole !== row.role ||
        nextUsername !== row.username;
      await tx
        .update(users)
        .set({
          username: nextUsername,
          role: nextRole as 'admin' | 'user',
          disabled: nextDisabled,
          updatedAt: Date.now(),
          ...(passwordHash === undefined ? {} : { passwordHash }),
          // A changed address falls back to unverified unless the admin says otherwise.
          ...(nextEmail === undefined ? {} : { email: nextEmail }),
          ...(emailChanged ? { emailVerified: email_verified ?? false } : {}),
          ...(!emailChanged && email_verified !== undefined ? { emailVerified: email_verified } : {}),
          ...(revoke ? { authVersion: sql`${users.authVersion} + 1` } : {}),
        })
        .where(eq(users.id, id));
      if (revoke) await revokeUserAuthentication(tx, id);
      return 'updated';
    });
    if (result === 'invalid_email') return jsonError(c, 'invalid_email');
    if (result === 'missing') return jsonError(c, 'user not found', 404);
    if (result === 'last_admin') return jsonError(c, 'last_active_admin_required', 409);
    if (result === 'username_taken') return jsonError(c, 'username already exists', 409);
    if (result === 'email_taken') return jsonError(c, 'email already exists', 409);
    return c.json({ ok: true });
  });

  router.delete('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return jsonError(c, 'invalid user ID');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(762441, 2)`);
      const [row] = await tx
        .select({ role: users.role, disabled: users.disabled })
        .from(users)
        .where(eq(users.id, id))
        .for('update')
        .limit(1);
      if (!row) return 'missing';
      if (row.role === 'admin' && !row.disabled) {
        const [{ value }] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
        if (value <= 1) return 'last_admin';
      }
      // Foreign keys remove every cookie, code and refresh token for this immutable user ID.
      await tx.delete(users).where(eq(users.id, id));
      return 'deleted';
    });
    if (result === 'missing') return jsonError(c, 'user not found', 404);
    if (result === 'last_admin') return jsonError(c, 'last_active_admin_required', 409);
    return c.json({ ok: true });
  });

  /** Metadata only: never expose API keys, OAuth access tokens or refresh tokens. */
  router.get('/admin/connections', async (c) => {
    c.header('Cache-Control', 'no-store');
    const rows = await db
      .select({
        userId: userMcpCredentials.userId,
        serverName: userMcpCredentials.serverName,
        mode: userMcpCredentials.mode,
        expiresAt: userMcpCredentials.expiresAt,
        refreshSecret: userMcpCredentials.refreshSecret,
        updatedAt: userMcpCredentials.updatedAt,
      })
      .from(userMcpCredentials);
    return c.json({
      connections: rows.map((row) => ({
        user_id: row.userId,
        server_name: row.serverName,
        mode: row.mode,
        expires_at: row.expiresAt,
        has_refresh_token: Boolean(row.refreshSecret),
        updated_at: row.updatedAt,
      })),
    });
  });

  router.delete('/admin/connections/:userId/:serverName', async (c) => {
    const userId = Number(c.req.param('userId'));
    const serverName = c.req.param('serverName');
    if (!Number.isSafeInteger(userId) || userId <= 0 || !SERVER_NAME_RE.test(serverName))
      return jsonError(c, 'invalid connection identifier');
    if (!(await revokeUserConnection(userId, serverName))) return jsonError(c, 'connection not found', 404);
    return c.json({ ok: true });
  });

  router.get('/admin/servers', async (c) => {
    const [{ value: wildcardUserCount }] = await db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'user'), eq(users.allServers, true)));
    const rows = await db
      .select({
        name: mcpServers.name,
        displayName: mcpServers.displayName,
        description: mcpServers.description,
        enabled: mcpServers.enabled,
        signupAccess: mcpServers.signupAccess,
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
        oauthClientSecretConfigured: sql<boolean>`${mcpServers.oauthClientSecret} IS NOT NULL`,
        createdAt: mcpServers.createdAt,
        userCount: count(userServerAccess.userId),
      })
      .from(mcpServers)
      .leftJoin(userServerAccess, eq(userServerAccess.serverName, mcpServers.name))
      .groupBy(mcpServers.name)
      .orderBy(mcpServers.name);
    const serverDtos = await Promise.all(
      rows.map(async (row) => {
        const instances = await db
          .select({ id: mcpServerInstances.id, url: mcpServerInstances.url, enabled: mcpServerInstances.enabled })
          .from(mcpServerInstances)
          .where(eq(mcpServerInstances.serverName, row.name))
          .orderBy(mcpServerInstances.id);
        return {
          name: row.name,
          display_name: row.displayName,
          description: row.description,
          enabled: row.enabled,
          signup_access: row.signupAccess,
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
          oauth_client_secret_configured: row.oauthClientSecretConfigured,
          user_count: Number(row.userCount) + Number(wildcardUserCount),
          created_at: row.createdAt,
          instances,
        };
      }),
    );
    return c.json({
      servers: serverDtos,
    });
  });

  router.post('/admin/servers/test-connection', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await c.req.json().catch(() => null);
    const endpoint = validateMcpEndpoint(body?.url);
    if (endpoint.error) return c.json(endpoint, 400);
    const result = await requestUpstreamTest(endpoint.url);
    if ('error' in result) return c.json(result, 400);
    return c.json(result);
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
    const id = body.id?.trim() || randomUUID();
    const now = Date.now();
    const inserted = await db
      .insert(mcpServerInstances)
      .values({ id, serverName, url, enabled: true, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: mcpServerInstances.id });
    if (!inserted.length) return jsonError(c, 'instance_already_exists', 409);
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
    const parsed = instancePatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return jsonError(c, parsed.error.issues[0]?.message ?? 'invalid_instance_payload');
    const body = parsed.data;
    const changes: Partial<typeof mcpServerInstances.$inferInsert> = { updatedAt: Date.now() };
    if (body.url !== undefined) {
      const endpoint = validateMcpEndpoint(body.url);
      if (endpoint.error) return c.json(endpoint, 400);
      changes.url = endpoint.url;
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
          const auth = authSettings(body as Record<string, unknown>, existing);
          if (auth.error) return { error: auth.error, status: 400 as const };
          credentialsChanged = Boolean(
            auth.values &&
            (existing.authMode !== auth.values.authMode ||
              (auth.values.authMode === 'api_key' &&
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

  // Keep a single admin entry point. The React application owns login and UI rendering.
  router.get('/admin', (c) => c.redirect(adminWebUrl(), 302));

  return router;
}
