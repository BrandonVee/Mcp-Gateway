import type { AdminRouter } from '../admin/context.js';
import { buildTopologySnapshot } from './service.js';

/** Mounted inside the administrator-only router. */
export function registerTopologyRoutes(router: AdminRouter) {
  router.get('/admin/topology/snapshot', async (c) => {
    c.header('Cache-Control', 'no-store');
    const window = c.req.query('window') === undefined ? 5 : Number(c.req.query('window'));
    if (![1, 5, 15, 30].includes(window)) return c.json({ error: 'invalid_window' }, 400);
    return c.json(await buildTopologySnapshot(window));
  });
}
