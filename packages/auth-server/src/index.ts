import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadSigningKeys } from './keys.js';
import { bootstrapAdmin, seedDemoUser } from './db.js';
import { seedDemoClient } from './clients.js';
import { authorizeRouter } from './authorize.js';
import { createTokenRouter } from './token.js';
import { createMetadataRouter } from './metadata.js';
import { createAdminRouter } from './admin.js';

const PORT = Number(process.env.PORT ?? 9001);
// What clients and the gateway see as the issuer. Must match on both sides.
const ISSUER = process.env.AUTH_ISSUER ?? `http://localhost:${PORT}`;
const ACCESS_TOKEN_TTL = Number(process.env.ACCESS_TOKEN_TTL ?? 3600);
// RFC 8707 resource indicators become JWT audience; fallback audience if the
// client does not send a `resource` parameter.
const DEFAULT_AUDIENCE = process.env.DEFAULT_AUDIENCE ?? 'mcp-gateway';

// Database bootstrap: initial admin account + demo seed.
bootstrapAdmin();
seedDemoUser();
seedDemoClient();

const keys = await loadSigningKeys();

const app = new Hono();

app.use('*', logger());
app.use('*', cors({ allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowHeaders: ['content-type', 'authorization'], credentials: true }));

app.get('/health', (c) => c.json({ ok: true, service: 'auth-server' }));

app.route('/', authorizeRouter);
app.route('/', createTokenRouter({ keys, issuer: ISSUER, accessTokenTtlSeconds: ACCESS_TOKEN_TTL, defaultAudience: DEFAULT_AUDIENCE }));
app.route('/', createMetadataRouter(keys, ISSUER));
app.route('/', createAdminRouter({ keys, issuer: ISSUER }));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`[auth-server] listening on :${PORT} (issuer: ${ISSUER})`);
  console.log(`[auth-server] metadata: ${ISSUER}/.well-known/oauth-authorization-server`);
  console.log(`[auth-server] admin UI:   ${ISSUER}/admin`);
});
