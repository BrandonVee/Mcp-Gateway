import { Hono } from 'hono';
import { createUpstreamConnectionsRouter } from '../upstreams/router.js';
import { registerConnectionMiddleware } from './middleware.js';
import { registerBrokerRoutes } from './routes/broker.js';
import { registerEmailRoutes } from './routes/email.js';
import { registerLegacyRoutes } from './routes/legacy.js';
import { registerMonitoringRoutes } from './routes/monitoring.js';
import { registerRegistrationRoutes } from './routes/registration.js';
import { registerSessionsRoutes } from './routes/sessions.js';

/** Shared browser security applies to legacy connections and independently scoped upstreams. */
export function createConnectionsRouter(): Hono {
  const router = new Hono();
  registerConnectionMiddleware(router);
  registerSessionsRoutes(router);
  registerRegistrationRoutes(router);
  registerEmailRoutes(router);
  registerMonitoringRoutes(router);
  registerLegacyRoutes(router);
  registerBrokerRoutes(router);
  router.route('/', createUpstreamConnectionsRouter());
  return router;
}
