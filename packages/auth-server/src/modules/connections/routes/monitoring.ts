import { Hono } from 'hono';
import { currentUser } from '../../identity/session-user.js';
import { listMonitoringCalls } from '../../monitoring/api.js';
/** Registers monitoring browser routes; write protection is applied by the parent router. */
export function registerMonitoringRoutes(router: Hono) {
  router.get('/me/monitoring/calls', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return listMonitoringCalls(c, user.role === 'admin' ? undefined : user.id);
  });
}
