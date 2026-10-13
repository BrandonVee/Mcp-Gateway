import { Hono } from 'hono';
import { registerBrokerRoutes } from './routes/broker.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerCredentialsRoutes } from './routes/credentials.js';
import { registerOauthRoutes } from './routes/oauth.js';

/** Route composition only; callers supply the shared browser middleware. */
export function createUpstreamConnectionsRouter() {
  const router = new Hono();
  registerCatalogRoutes(router);
  registerCredentialsRoutes(router);
  registerOauthRoutes(router);
  registerBrokerRoutes(router);
  return router;
}
