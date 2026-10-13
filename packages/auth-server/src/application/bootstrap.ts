import { serve } from '@hono/node-server';
import { authIssuer, loadPlatformConfig, validateProductionRuntime } from '@mcp/shared';
import { rateLimitHealthy } from '../infrastructure/cache/rate-limit.js';
import {
  assertNoDevelopmentFixtures,
  initializeDatabase,
  startExpirySweep,
} from '../infrastructure/database/lifecycle.js';
import { bootstrapAdmin } from '../modules/identity/bootstrap.js';
import { startMonitoring } from '../modules/monitoring/collector.js';
import { loadSigningKeys } from '../modules/oauth/keys.js';
import { refreshSystemSettings } from '../modules/system/settings.js';
import { createAuthApp } from './app.js';

/** Persistent bootstrap completes before any public listener accepts traffic. */
export async function startAuthServer(): Promise<void> {
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

  const app = createAuthApp({ keys, accessTokenTtlSeconds: ACCESS_TOKEN_TTL, defaultAudience: DEFAULT_AUDIENCE });
  serve({ fetch: app.fetch, port: PORT, hostname: process.env.AUTH_LISTEN_HOST ?? '0.0.0.0' }, () => {
    console.log(`[auth-server] listening on :${PORT} (issuer: ${authIssuer() || 'setup pending'})`);
    console.log(`[auth-server] metadata: ${authIssuer() || 'setup pending'}/.well-known/oauth-authorization-server`);
    console.log(`[auth-server] admin UI:   ${authIssuer() || 'setup pending'}/admin`);
  });
}
