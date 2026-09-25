import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { loadSigningKeys } from './keys.js';
import { bootstrapAdmin, db, initializeDatabase, startExpirySweep } from './db.js';
import { authorizeRouter } from './authorize.js';
import { createTokenRouter } from './token.js';
import { createMetadataRouter } from './metadata.js';
import { createAdminRouter } from './admin.js';
import { loadPlatformConfig, validateProductionRuntime } from '@mcp/shared';
import { users } from './schema.js';
import { createRegistryRouter } from './registry.js';
import { createConnectionsRouter } from './connections.js';

const config = loadPlatformConfig();
validateProductionRuntime(config, 'auth');
const PORT = config.auth.port;
const ISSUER = config.auth.issuer;
const ACCESS_TOKEN_TTL = config.auth.accessTokenTtlSeconds;
// RFC 8707 resource indicators become JWT audience; fallback audience if the
// client does not send a `resource` parameter.
const DEFAULT_AUDIENCE = config.auth.defaultAudience;

// Database bootstrap: schema and the initial administrator only.
await initializeDatabase();
await bootstrapAdmin();
startExpirySweep();

const keys = await loadSigningKeys();

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
    console.error(JSON.stringify({ level: 'error', service: 'auth', request_id: requestId, error: error instanceof Error ? error.name : 'UnknownError' }));
    throw error;
  } finally {
    // Do not log query strings, headers or bodies: OAuth URLs can contain codes.
    if (c.req.path !== '/health' && c.req.path !== '/live') {
      console.log(JSON.stringify({
        level: failed ? 'error' : 'info',
        service: 'auth',
        request_id: requestId,
        method: c.req.method,
        path: c.req.path,
        status: failed ? 500 : c.res.status,
        duration_ms: Math.round(performance.now() - start),
      }));
    }
  }
});
app.use('*', cors({ allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowHeaders: ['content-type', 'authorization'], credentials: true }));

app.get('/live', (c) => c.json({ ok: true, service: 'auth-server' }));

app.get('/health', async (c) => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    return c.json({ ok: true, service: 'auth-server', postgres: true });
  } catch {
    return c.json({ ok: false, service: 'auth-server', postgres: false }, 503);
  }
});

app.route('/', authorizeRouter);
app.route('/', createTokenRouter({ keys, issuer: ISSUER, accessTokenTtlSeconds: ACCESS_TOKEN_TTL, defaultAudience: DEFAULT_AUDIENCE }));
app.route('/', createMetadataRouter(keys, ISSUER));
app.route('/', createAdminRouter({ keys, issuer: ISSUER }));
app.route('/', createRegistryRouter());
app.route('/', createConnectionsRouter());

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`[auth-server] listening on :${PORT} (issuer: ${ISSUER})`);
  console.log(`[auth-server] metadata: ${ISSUER}/.well-known/oauth-authorization-server`);
  console.log(`[auth-server] admin UI:   ${ISSUER}/admin`);
});
