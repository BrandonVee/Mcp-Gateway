import { Hono } from 'hono';
import { currentUser } from '../../identity/session-user.js';
import { listUpstreamConnections } from '../user-catalog.js';
/** Registers catalog operations for concrete upstreams, with per-owner credential isolation. */
export function registerCatalogRoutes(router: Hono) {
  router.get('/me/upstreams', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await listUpstreamConnections(user));
  });
}
