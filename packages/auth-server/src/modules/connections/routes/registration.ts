import { authIssuer, normalizeEmail, registrationEmailVerificationEnabled, registrationEnabled } from '@mcp/shared';
import { Hono } from 'hono';
import { consumeRateLimit } from '@/auth/infrastructure/cache/rate-limit.js';
import { setSessionCookie } from '@/auth/shared/http/session-cookie.js';
import { createRegisteredUser, sendSignupEmailCode, validateSignup } from '@/auth/modules/identity/registration.js';
import { currentUser } from '@/auth/modules/identity/session-user.js';
import { createLoginSession } from '@/auth/modules/identity/sessions.js';
import { signupErrors } from '@/auth/modules/connections/context.js';
/** Registers registration browser routes; write protection is applied by the parent router. */
export function registerRegistrationRoutes(router: Hono) {
  /** Anonymous read so the login page can hide the entry when signup is closed. */
  router.get('/me/signup', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      registration_enabled: registrationEnabled(),
      registration_email_verification: registrationEmailVerificationEnabled(),
    });
  });

  router.post('/me/signup/send-code', async (c) => {
    if (!registrationEnabled() || !registrationEmailVerificationEnabled())
      return c.json({ error: 'registration_disabled' }, 403);
    if (await currentUser(c)) return c.json({ error: 'already_authenticated' }, 409);
    const body = await c.req.json().catch(() => null);
    try {
      const result = await sendSignupEmailCode(typeof body?.email === 'string' ? body.email : '');
      return result === 'sent'
        ? c.json({ ok: true })
        : c.json({ error: result }, result === 'rate_limit_exceeded' ? 429 : result === 'invalid_email' ? 400 : 503);
    } catch {
      return c.json({ error: 'smtp_send_failed' }, 502);
    }
  });

  router.post('/me/signup', async (c) => {
    if (!registrationEnabled()) return c.json({ error: 'registration_disabled' }, 403);
    // A stale tab signing up would overwrite the session cookie of the current identity.
    if (await currentUser(c)) return c.json({ error: 'already_authenticated' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      email?: string;
      password?: string;
      confirm_password?: string;
      verification_code?: string;
    };
    const email = typeof body.email === 'string' ? body.email : typeof body.username === 'string' ? body.username : '';
    const username = normalizeEmail(email) ?? '';
    const password = typeof body.password === 'string' ? body.password : '';
    const invalid = validateSignup(
      username,
      email,
      password,
      typeof body.confirm_password === 'string' ? body.confirm_password : '',
    );
    if (invalid) return c.json({ error: signupErrors[invalid] }, 400);
    try {
      // Shares the OAuth sign-up budget so neither entry point offers more attempts.
      if (!(await consumeRateLimit('signup-account', username.toLowerCase(), 5, 3600))) {
        c.header('Retry-After', '3600');
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
    } catch {
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    let user: { id: number; username: string; role: 'admin' | 'user'; authVersion: number };
    let token: string;
    try {
      const result = await createRegisteredUser(
        username,
        email,
        password,
        typeof body.verification_code === 'string' ? body.verification_code : '',
      );
      if (result.status !== 'created')
        return c.json(
          { error: result.status },
          result.status === 'invalid_verification_code'
            ? 400
            : result.status === 'verification_unavailable'
              ? 503
              : 409,
        );
      user = result.user;
      token = await createLoginSession(user.id, user.authVersion);
    } catch {
      return c.json({ error: 'registration_unavailable' }, 503);
    }
    setSessionCookie(c, token, authIssuer());
    return c.json(
      {
        authenticated: true,
        username: user.username,
        role: user.role,
        user_id: user.id,
        auth_version: user.authVersion,
      },
      201,
    );
  });
}
