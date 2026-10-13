import { adminWebUrl } from '@mcp/shared';
import { getCookie } from 'hono/cookie';
import { browserOriginAllowed } from '@/auth/shared/http/origin.js';
import { jsonError } from '@/auth/shared/http/responses.js';
import { SESSION_COOKIE } from '@/auth/shared/http/session-cookie.js';
import { recordAudit } from '@/auth/modules/audit/service.js';
import { getSessionUser } from '@/auth/modules/identity/sessions.js';
import { getAdminActor, type AdminDeps, type AdminRouter } from '@/auth/modules/admin/context.js';

/** Check origin and immutable identity before resolving the administrator; audit writes afterwards. */
export function registerAdminMiddleware(router: AdminRouter, deps: AdminDeps) {
  // Guard everything under /admin.
  router.use('/admin/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const allowed = browserOriginAllowed(origin, c.req.header('host'), () => [deps.issuer, adminWebUrl()]);
      if (!allowed) return jsonError(c, 'invalid_origin', 403);
      const expectedIdentity = c.req.header('x-session-identity');
      const login = c.req.method === 'POST' && c.req.path === '/admin/session';
      if (!login && expectedIdentity !== undefined && !c.req.header('authorization')?.startsWith('Bearer ')) {
        const cookie = getCookie(c, SESSION_COOKIE);
        const session = cookie ? await getSessionUser(cookie) : null;
        const expiredLogout = !session && c.req.method === 'DELETE' && c.req.path === '/admin/session';
        if (!expiredLogout && (!session || expectedIdentity !== `${session.userId}:${session.userAuthVersion}`)) {
          return jsonError(c, 'session_changed', 409);
        }
      }
    }
    if (c.req.path === '/admin' || c.req.path === '/admin/session') {
      await next();
      return;
    }
    const actor = await getAdminActor(c, deps);
    if (!actor) return jsonError(c, 'admin privileges required', 403);
    c.set('adminActor', actor);
    await next();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      await recordAudit(c, actor, c.res.status);
    }
  });
}
