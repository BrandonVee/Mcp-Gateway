import { adminWebUrl, authIssuer } from '@mcp/shared';
import type { Hono } from 'hono';
import { browserOriginAllowed } from '@/auth/shared/http/origin.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';

/** Protect browser writes against cross-origin and stale-tab identity changes. */
export function registerConnectionMiddleware(router: Hono) {
  // Browser writes require a same-origin request. The Vite proxy uses the web origin.
  router.use('/me/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const allowed = browserOriginAllowed(origin, c.req.header('host'), () => [authIssuer(), adminWebUrl()]);
      if (!allowed) return c.json({ error: 'invalid_origin' }, 403);
      const expectedIdentity = c.req.header('x-session-identity');
      // Sign-in and self-registration are the only anonymous writes.
      const anonymous =
        c.req.method === 'POST' &&
        (c.req.path === '/me/session' || c.req.path === '/me/signup' || c.req.path === '/me/signup/send-code');
      if (expectedIdentity !== undefined && !anonymous) {
        const user = await currentUser(c);
        const expiredLogout = !user && c.req.method === 'DELETE' && c.req.path === '/me/session';
        if (!expiredLogout && (!user || expectedIdentity !== `${user.id}:${user.authVersion}`)) {
          return c.json({ error: 'session_changed' }, 409);
        }
      }
    }
    await next();
  });
}
