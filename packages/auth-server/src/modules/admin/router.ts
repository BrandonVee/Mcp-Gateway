import { adminWebUrl } from '@mcp/shared';
import { Hono } from 'hono';
import { registerMonitoringRoutes } from '@/auth/modules/monitoring/api.js';
import { registerTopologyRoutes } from '@/auth/modules/topology/api.js';
import type { AdminDeps, AdminEnvironment } from '@/auth/modules/admin/context.js';
import { registerAdminMiddleware } from '@/auth/modules/admin/middleware.js';
import { registerAuditRoutes } from '@/auth/modules/admin/routes/audit.js';
import { registerConnectionsRoutes } from '@/auth/modules/admin/routes/connections.js';
import { registerEndpointsRoutes } from '@/auth/modules/admin/routes/endpoints.js';
import { registerGrantsRoutes } from '@/auth/modules/admin/routes/grants.js';
import { registerSessionRoutes } from '@/auth/modules/admin/routes/session.js';
import { registerSettingsRoutes } from '@/auth/modules/admin/routes/settings.js';
import { registerUpdatesRoutes } from '@/auth/modules/admin/routes/updates.js';
import { registerUpstreamsRoutes } from '@/auth/modules/admin/routes/upstreams.js';
import { registerUsersRoutes } from '@/auth/modules/admin/routes/users.js';

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
