import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { loadSigningKeys } from './keys.js';
import { assertNoDevelopmentFixtures, bootstrapAdmin, db, initializeDatabase, startExpirySweep } from './db.js';
import { authorizeRouter } from './authorize.js';
import { createTokenRouter } from './token.js';
import { createMetadataRouter } from './metadata.js';
import { createAdminRouter } from './admin.js';
import { loadPlatformConfig, validateProductionRuntime, authIssuer, systemConfigured } from '@mcp/shared';
import { users } from './schema.js';
import { refreshSystemSettings } from './system-settings.js';
import { startMonitoring } from './monitoring.js';
import { createRegistryRouter } from './registry.js';
import { createConnectionsRouter } from './connections.js';
import { limitRequest, rateLimitHealthy } from './rate-limit.js';

const config = loadPlatformConfig();
validateProductionRuntime(config, 'auth');
const PORT = config.auth.port;
const ACCESS_TOKEN_TTL = config.auth.accessTokenTtlSeconds;
// RFC 8707 resource indicators become JWT audience; fallback audience if the
// client does not send a `resource` parameter.
const DEFAULT_AUDIENCE = config.auth.defaultAudience;

// Database bootstrap: schema and the initial administrator only.
await initializeDatabase();
await refreshSystemSettings();
await assertNoDevelopmentFixtures();
await bootstrapAdmin();
startExpirySweep();
startMonitoring();

const keys = await loadSigningKeys();
if (!(await rateLimitHealthy())) throw new Error('Redis rate limiter is unavailable');

const app = new Hono();

app.use('*', async (c, next) => {
  const requestId = randomUUID();
  const start = performance.now();
  c.header('X-Request-Id', requestId);
  let failed = false;
  try {
    await next();
  } catch (error) {
    failed = true;
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'auth',
        request_id: requestId,
        error: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    throw error;
  } finally {
    // Do not log query strings, headers or bodies: OAuth URLs can contain codes.
    if (c.req.path !== '/health' && c.req.path !== '/live') {
      console.log(
        JSON.stringify({
          level: failed ? 'error' : 'info',
          service: 'auth',
          request_id: requestId,
          method: c.req.method,
          path: c.req.path,
          status: failed ? 500 : c.res.status,
          duration_ms: Math.round(performance.now() - start),
        }),
      );
    }
  }
});
app.use('*', async (c, next) => {
  if (!['/live', '/health'].includes(c.req.path)) {
    try {
      await refreshSystemSettings();
    } catch {
      return c.json({ error: 'system_settings_unavailable' }, 503);
    }
    if (
      !systemConfigured() &&
      // The shared browser login must remain reachable so an administrator can
      // sign in and finish setup before OAuth and personal MCP access open.
      c.req.path !== '/me/session' &&
      (/^\/(authorize(?:\/|$)|token$|register$|me(?:\/|$)|oauth(?:\/|$))/.test(c.req.path) ||
        c.req.path.startsWith('/.well-known/'))
    )
      return c.json({ error: 'system_not_configured' }, 503);
  }
  await next();
});
app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
app.use(
  '*',
  cors({
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization', 'x-session-identity'],
    credentials: true,
  }),
);

const publicPostLimits: Record<string, [number, number]> = {
  '/authorize/submit': [30, 60],
  '/authorize/signup': [10, 3600],
  '/admin/session': [20, 60],
  '/me/session': [20, 60],
  // Separate from /authorize/signup: one address may create twice as many accounts.
  '/me/signup': [10, 3600],
  '/me/email/send-code': [10, 3600],
  '/me/email/verify': [20, 3600],
  '/token': [120, 60],
  '/register': [20, 60],
};
app.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const policy = publicPostLimits[c.req.path];
    if (policy) {
      let allowed: boolean;
      try {
        allowed = await limitRequest(c, c.req.path, policy[0], policy[1]);
      } catch {
        return c.json({ error: 'rate_limit_unavailable' }, 503);
      }
      if (!allowed) {
        c.header('Retry-After', String(policy[1]));
        console.warn(
          JSON.stringify({ level: 'warn', service: 'auth', event: 'rate_limit_exceeded', path: c.req.path }),
        );
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
    }
  }
  if (
    [
      '/authorize',
      '/authorize/submit',
      '/authorize/signup',
      '/token',
      '/admin/session',
      '/me/session',
      '/me/signup',
      '/register',
    ].includes(c.req.path)
  ) {
    c.header('Cache-Control', 'no-store');
  }
  await next();
});

app.get('/live', (c) => c.json({ ok: true, service: 'auth-server' }));

app.get('/health', async (c) => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    const redis = await rateLimitHealthy();
    return c.json({ ok: redis, service: 'auth-server', postgres: true, redis }, redis ? 200 : 503);
  } catch {
    return c.json({ ok: false, service: 'auth-server', postgres: false }, 503);
  }
});

app.route('/', authorizeRouter);
app.route(
  '/',
  createTokenRouter({
    keys,
    get issuer() {
      return authIssuer();
    },
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL,
    defaultAudience: DEFAULT_AUDIENCE,
  }),
);
app.route('/', createMetadataRouter(keys, authIssuer));
app.route(
  '/',
  createAdminRouter({
    keys,
    get issuer() {
      return authIssuer();
    },
  }),
);
app.route('/', createRegistryRouter());
app.route('/', createConnectionsRouter());

serve({ fetch: app.fetch, port: PORT, hostname: process.env.AUTH_LISTEN_HOST ?? '0.0.0.0' }, () => {
  console.log(`[auth-server] listening on :${PORT} (issuer: ${authIssuer() || 'setup pending'})`);
  console.log(`[auth-server] metadata: ${authIssuer() || 'setup pending'}/.well-known/oauth-authorization-server`);
  console.log(`[auth-server] admin UI:   ${authIssuer() || 'setup pending'}/admin`);
});
