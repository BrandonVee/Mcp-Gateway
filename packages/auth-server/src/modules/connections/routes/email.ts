import { Hono } from 'hono';
import { consumeRateLimit } from '@/auth/infrastructure/cache/rate-limit.js';
import { sendEmailVerificationCode, verifyEmailCode } from '@/auth/modules/identity/email-verification.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
/** Registers email browser routes; write protection is applied by the parent router. */
export function registerEmailRoutes(router: Hono) {
  /** Sends a fresh verification code to the signed-in user's email address. */
  router.post('/me/email/send-code', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    try {
      if (!(await consumeRateLimit('email-verify-send', String(user.id), 5, 3600))) {
        c.header('Retry-After', '3600');
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
    } catch {
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    try {
      const result = await sendEmailVerificationCode(user.id);
      if (result === 'no_email') return c.json({ error: 'email_missing' }, 400);
      if (result === 'not_configured') return c.json({ error: 'smtp_not_configured' }, 503);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'smtp_send_failed' }, 502);
    }
  });

  router.post('/me/email/verify', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return c.json({ error: 'invalid_code' }, 400);
    try {
      if (!(await consumeRateLimit('email-verify-check', String(user.id), 10, 3600))) {
        c.header('Retry-After', '3600');
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
    } catch {
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    const result = await verifyEmailCode(user.id, code);
    return result === 'verified' ? c.json({ ok: true }) : c.json({ error: 'invalid_code' }, 400);
  });
}
