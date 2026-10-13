import { authIssuer } from '@mcp/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { db } from '../../../infrastructure/database/client.js';
import { users } from '../../../infrastructure/database/schema.js';
import { enforceLoginAccountLimit } from '../../../shared/http/login-rate-limit.js';
import { clearSessionCookie, cookieName, setSessionCookie } from '../../../shared/http/session-cookie.js';
import { recordAudit } from '../../audit/service.js';
import { verifyUser } from '../../identity/authentication.js';
import { currentUser } from '../../identity/session-user.js';
import { createLoginSession, deleteLoginSession } from '../../identity/sessions.js';
/** Registers sessions browser routes; write protection is applied by the parent router. */
export function registerSessionsRoutes(router: Hono) {
  router.get('/me/session', async (c) => {
    const user = await currentUser(c);
    return user
      ? c.json({
          authenticated: true,
          username: user.username,
          role: user.role,
          user_id: user.id,
          auth_version: user.authVersion,
          email: user.email,
          email_verified: user.emailVerified,
        })
      : c.json({ error: 'unauthorized' }, 401);
  });

  router.post('/me/session', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const limited = await enforceLoginAccountLimit(c, body.username);
    if (limited) return limited;
    const user =
      typeof body.username === 'string' && typeof body.password === 'string'
        ? await verifyUser(body.username.trim(), body.password)
        : null;
    if (!user) {
      if (typeof body.username === 'string') {
        const [account] = await db
          .select({ username: users.username, role: users.role })
          .from(users)
          .where(eq(users.username, body.username.trim()))
          .limit(1);
        if (account?.role === 'admin') await recordAudit(c, account.username, 401);
      }
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    let token: string;
    try {
      token = await createLoginSession(user.id, user.authVersion);
    } catch {
      if (user.role === 'admin') await recordAudit(c, user.username, 401);
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    setSessionCookie(c, token, authIssuer());
    if (user.role === 'admin') await recordAudit(c, user.username, 200);
    return c.json({
      authenticated: true,
      username: user.username,
      role: user.role,
      user_id: user.id,
      auth_version: user.authVersion,
      email: user.email,
      email_verified: user.emailVerified,
    });
  });

  router.delete('/me/session', async (c) => {
    const user = await currentUser(c);
    const token = getCookie(c, cookieName);
    if (token) await deleteLoginSession(token);
    clearSessionCookie(c);
    if (user?.role === 'admin') await recordAudit(c, user.username, 200);
    return c.json({ authenticated: false });
  });
}
