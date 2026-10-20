import { Hono } from 'hono';
import { createUpstreamConnectionsRouter } from '@/auth/modules/upstreams/router.js';
import { registerConnectionMiddleware } from '@/auth/modules/connections/middleware.js';
import { registerBrokerRoutes } from '@/auth/modules/connections/routes/broker.js';
import { registerEmailRoutes } from '@/auth/modules/connections/routes/email.js';
import { registerPoolConnectionRoutes } from '@/auth/modules/connections/pool/routes.js';
import { registerMonitoringRoutes } from '@/auth/modules/connections/routes/monitoring.js';
import { registerRegistrationRoutes } from '@/auth/modules/connections/routes/registration.js';
import { registerSessionsRoutes } from '@/auth/modules/connections/routes/sessions.js';
import { registerApiKeyRoutes } from '@/auth/modules/connections/routes/api-keys.js';

/** Shared browser security applies to pool connections and independently scoped upstreams. */
export function createConnectionsRouter(): Hono {
  const router = new Hono();
  registerConnectionMiddleware(router);
  registerSessionsRoutes(router);
  registerApiKeyRoutes(router);
  registerRegistrationRoutes(router);
  registerEmailRoutes(router);
  registerMonitoringRoutes(router);
  registerPoolConnectionRoutes(router);
  registerBrokerRoutes(router);
  router.route('/', createUpstreamConnectionsRouter());
  return router;
}
