import { getCookie } from 'hono/cookie';
import { enforceLoginAccountLimit } from '../../../shared/http/login-rate-limit.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../../../shared/http/session-cookie.js';
import { recordAudit } from '../../audit/service.js';
import { verifyUser } from '../../identity/authentication.js';
import { createLoginSession, deleteLoginSession } from '../../identity/sessions.js';
import type { AdminDeps, AdminRouter } from '../context.js';
import { getAdminActor } from '../context.js';
import { SERVER_NAME_RE } from '../validation.js';
/** Registers session routes under the shared administrator guard. */
export function registerSessionRoutes(router: AdminRouter, deps: AdminDeps) {
  router.get('/admin/session', async (c) => {
    const authenticated = Boolean(await getAdminActor(c, deps));
    return c.json({ authenticated }, authenticated ? 200 : 401);
  });

  router.post('/admin/session', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const limited = await enforceLoginAccountLimit(c, body.username);
    if (limited) return limited;
    const user =
      typeof body.username === 'string' && typeof body.password === 'string'
        ? await verifyUser(body.username.trim(), body.password)
        : null;
    if (!user || user.role !== 'admin') {
      await recordAudit(
        c,
        typeof body.username === 'string' && SERVER_NAME_RE.test(body.username) ? body.username : 'anonymous',
        401,
      );
      return c.json({ error: 'invalid_admin_credentials' }, 401);
    }
    let token: string;
    try {
      token = await createLoginSession(user.id, user.authVersion);
    } catch {
      return c.json({ error: 'invalid_admin_credentials' }, 401);
    }
    setSessionCookie(c, token, deps.issuer);
    await recordAudit(c, user.username, 200);
    return c.json({ authenticated: true, username: user.username });
  });

  router.delete('/admin/session', async (c) => {
    const actor = await getAdminActor(c, deps);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteLoginSession(token);
    clearSessionCookie(c);
    if (actor) await recordAudit(c, actor, 200);
    return c.json({ authenticated: false });
  });
}
