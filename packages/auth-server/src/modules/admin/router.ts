import { adminWebUrl } from '@mcp/shared';
import { Hono } from 'hono';
import { registerMonitoringRoutes } from '../monitoring/api.js';
import { registerTopologyRoutes } from '../topology/api.js';
import type { AdminDeps, AdminEnvironment } from './context.js';
import { registerAdminMiddleware } from './middleware.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConnectionsRoutes } from './routes/connections.js';
import { registerEndpointsRoutes } from './routes/endpoints.js';
import { registerGrantsRoutes } from './routes/grants.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerUpdatesRoutes } from './routes/updates.js';
import { registerUpstreamsRoutes } from './routes/upstreams.js';
import { registerUsersRoutes } from './routes/users.js';

/** Compose administrator routes without owning domain or database logic. */
export function createAdminRouter(deps: AdminDeps) {
  const router = new Hono<AdminEnvironment>();
  registerAdminMiddleware(router, deps);
  registerMonitoringRoutes(router);
  registerTopologyRoutes(router);
  registerSessionRoutes(router, deps);
  registerSettingsRoutes(router, deps);
  registerUpdatesRoutes(router);
  registerAuditRoutes(router);
  registerUsersRoutes(router);
  registerGrantsRoutes(router);
  registerConnectionsRoutes(router);
  registerEndpointsRoutes(router);
  registerUpstreamsRoutes(router);
  router.get('/admin', (c) => c.redirect(adminWebUrl(), 302));
  return router;
}
