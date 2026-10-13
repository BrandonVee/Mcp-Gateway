import { z } from 'zod';
import { DockerError } from '../../../infrastructure/docker/client.js';
import { getUpdateStatus, getUpdateTaskStatus, startUpdate } from '../../system/update-service.js';
import { updateEnabled } from '../../system/update-identity.js';

import type { AdminRouter } from '../context.js';
/** Registers updates routes under the shared administrator guard. */
export function registerUpdatesRoutes(router: AdminRouter) {
  router.get('/admin/system-update', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!updateEnabled()) return c.json({ error: 'system_update_disabled' }, 503);
    return c.json(
      await getUpdateStatus(process.env, c.req.query('check') === 'true', c.req.query('runtime') === 'true'),
    );
  });

  router.get('/admin/system-update/tasks/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!updateEnabled()) return c.json({ error: 'system_update_disabled' }, 503);
    try {
      return c.json(await getUpdateTaskStatus(c.req.param('id')));
    } catch (error) {
      return c.json(
        { error: error instanceof DockerError ? error.message : 'system_update_failed' },
        error instanceof DockerError && error.status === 400 ? 400 : 503,
      );
    }
  });

  router.post('/admin/system-update', async (c) => {
    if (!updateEnabled()) return c.json({ error: 'system_update_disabled' }, 503);
    try {
      // Returns as soon as the updater container exists: pulling the image
      // happens there, well past the proxy's response timeout.
      const body = await c.req.json().catch(() => null);
      const parsed = z
        .object({ tag: z.string().max(64).optional() })
        .strict()
        .safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_update_version' }, 400);
      return c.json(await startUpdate(process.env, parsed.data.tag ?? 'latest'), 202);
    } catch (error) {
      if (error instanceof DockerError) return c.json({ error: error.message }, error.status as 400 | 409 | 503);
      return c.json({ error: 'system_update_failed' }, 503);
    }
  });
}
