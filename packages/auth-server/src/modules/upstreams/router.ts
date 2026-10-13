import { Hono } from 'hono';
import { registerBrokerRoutes } from '@/auth/modules/upstreams/routes/broker.js';
import { registerCatalogRoutes } from '@/auth/modules/upstreams/routes/catalog.js';
import { registerCredentialsRoutes } from '@/auth/modules/upstreams/routes/credentials.js';
import { registerOauthRoutes } from '@/auth/modules/upstreams/routes/oauth.js';

/** Route composition only; callers supply the shared browser middleware. */
export function createUpstreamConnectionsRouter() {
  const router = new Hono();
  registerCatalogRoutes(router);
  registerCredentialsRoutes(router);
  registerOauthRoutes(router);
  registerBrokerRoutes(router);
  return router;
}
