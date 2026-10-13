import { authIssuer } from '@mcp/shared';
import { Hono } from 'hono';
import { rateLimitHealthy } from '../infrastructure/cache/rate-limit.js';
import { db } from '../infrastructure/database/client.js';
import { users } from '../infrastructure/database/schema.js';
import { createAdminRouter } from '../modules/admin/router.js';
import { createConnectionsRouter } from '../modules/connections/router.js';
import { authorizeRouter } from '../modules/oauth/authorize.js';
import type { SigningKeys } from '../modules/oauth/keys.js';
import { createMetadataRouter } from '../modules/oauth/metadata.js';
import { createTokenRouter } from '../modules/oauth/token.js';
import { createRegistryRouter } from '../modules/upstreams/registry.js';
import { registerApplicationMiddleware } from './middleware.js';

export interface AuthAppOptions {
  keys: SigningKeys;
  accessTokenTtlSeconds: number;
  defaultAudience: string;
}

/** Compose HTTP routes without opening listeners or bootstrapping persistent state. */
export function createAuthApp(options: AuthAppOptions): Hono {
  const app = new Hono();
  const { keys } = options;
  registerApplicationMiddleware(app);
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
      accessTokenTtlSeconds: options.accessTokenTtlSeconds,
      defaultAudience: options.defaultAudience,
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

  return app;
}
