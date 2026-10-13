import {
  authIssuer,
  gatewayPublicUrl,
  normalizeEmail,
  registrationEmailVerificationEnabled,
  registrationEnabled,
} from '@mcp/shared';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { consumeRateLimit, limitLoginAccount } from '@/auth/infrastructure/cache/rate-limit.js';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServers } from '@/auth/infrastructure/database/schema.js';
import { getUserAuthorization, verifyUser, type AuthIdentity } from '@/auth/modules/identity/authentication.js';
import { createRegisteredUser, sendSignupEmailCode, validateSignup } from '@/auth/modules/identity/registration.js';
import { createLoginSession, getSessionUser } from '@/auth/modules/identity/sessions.js';
import { getClient, isRedirectUriAllowed } from '@/auth/modules/oauth/clients.js';
import {
  authorizationLink,
  authorizationParams,
  consentPage,
  loginPage,
  pageLanguage,
  signupPage,
  type AuthPageDetails,
  type AuthPageError,
  type AuthPageLanguage,
} from '@/auth/modules/oauth/pages.js';
import { saveAuthCode } from '@/auth/modules/oauth/stores.js';

/** Authorization Code + PKCE, with sign-in and self-registration in the same browser flow. */
export const authorizeRouter = new Hono();
const SCOPE_RE = /^[\x21\x23-\x5B\x5D-\x7E\s]*$/;
const SESSION_COOKIE = 'auth_session';
const SIGNUP_FORM_COOKIE = 'mcp_signup_form';

// These pages contain authorization state and credentials, and must not be cached or framed.
const protectAuthPage = async (c: Context, next: () => Promise<void>) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  );
  await next();
};
authorizeRouter.use('/authorize', protectAuthPage);
authorizeRouter.use('/authorize/*', protectAuthPage);

authorizeRouter.get('/authorize', async (c) => {
  const q = authorizationParams(c.req.query());
  const language = pageLanguage(c.req.query('lang'), c.req.header('accept-language'));
  const error = await validateAuthorizeParams(q);
  if (error) return c.json(error, 400);
  c.header('Content-Language', language);
  const details = await pageDetails(q);
  const session = await getSessionFromCookie(c);
  if (session) {
    const authorization = await getUserAuthorization(session.userId);
    if (authorization && !authorization.disabled) {
      const name = resourceServer(q.resource);
      const needsAccess = Boolean(
        name && !authorization.servers.includes('*') && !authorization.servers.includes(name),
      );
      return c.html(consentPage(q, session.sub, language, details, c.req.query('registered') === '1', needsAccess));
    }
  }
  return c.html(loginPage(q, language, details));
});

authorizeRouter.get('/authorize/signup', async (c) => {
  const q = authorizationParams(c.req.query());
  const language = pageLanguage(c.req.query('lang'), c.req.header('accept-language'));
  const invalid = await validateAuthorizeParams(q);
  if (invalid) return c.json(invalid, 400);
  if (!registrationEnabled()) return c.html(loginPage(q, language, await pageDetails(q), 'registrationDisabled'), 403);
  if (await getSessionFromCookie(c)) return c.redirect(authorizationLink('/authorize', q, language), 302);
  return showSignup(c, q, language);
});

authorizeRouter.post('/authorize/signup', async (c) => {
  const form = await c.req.parseBody();
  const str = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : '');
  const q = authorizationParams(form);
  const language = pageLanguage(str('lang'), c.req.header('accept-language'));
  const invalid = await validateAuthorizeParams(q);
  if (invalid) return c.json(invalid, 400);
  if (!registrationEnabled()) return c.html(loginPage(q, language, await pageDetails(q), 'registrationDisabled'), 403);
  const email = str('email').trim();
  const username = normalizeEmail(email) ?? '';
  const submittedToken = str('form_token');
  const cookieToken = getCookie(c, SIGNUP_FORM_COOKIE) ?? '';
  const origin = c.req.header('origin');
  if (
    (origin && origin !== new URL(authIssuer()).origin) ||
    !/^[A-Za-z0-9_-]{43}$/.test(submittedToken) ||
    !/^[A-Za-z0-9_-]{43}$/.test(cookieToken) ||
    !timingSafeEqual(Buffer.from(cookieToken), Buffer.from(submittedToken))
  ) {
    return showSignup(c, q, language, 'invalidForm', username, email, 403);
  }
  if (await getSessionFromCookie(c)) return c.redirect(authorizationLink('/authorize', q, language), 303);
  if (str('action') === 'send-code') {
    if (!registrationEmailVerificationEnabled())
      return showSignup(c, q, language, 'registrationDisabled', username, email, 403);
    try {
      const result = await sendSignupEmailCode(email);
      return showSignup(
        c,
        q,
        language,
        result === 'sent'
          ? 'verificationSent'
          : result === 'invalid_email'
            ? 'invalidEmail'
            : result === 'rate_limit_exceeded'
              ? 'tooManyAttempts'
              : 'serviceUnavailable',
        username,
        email,
        result === 'sent' ? 200 : 400,
      );
    } catch {
      return showSignup(c, q, language, 'serviceUnavailable', username, email, 503);
    }
  }
  const signupError = validateSignup(username, email, str('password'), str('confirm_password'));
  if (signupError) return showSignup(c, q, language, signupError, username, email, 400);
  try {
    if (!(await consumeRateLimit('signup-account', username.toLowerCase(), 5, 3600))) {
      c.header('Retry-After', '3600');
      return showSignup(c, q, language, 'tooManyAttempts', username, email, 429);
    }
  } catch {
    return showSignup(c, q, language, 'serviceUnavailable', username, email, 503);
  }
  try {
    const result = await createRegisteredUser(username, email, str('password'), str('verification_code'));
    if (result.status !== 'created') {
      return showSignup(
        c,
        q,
        language,
        result.status === 'invalid_verification_code'
          ? 'invalidVerificationCode'
          : result.status === 'verification_unavailable'
            ? 'serviceUnavailable'
            : result.status === 'username_taken'
              ? 'usernameTaken'
              : 'emailTaken',
        username,
        email,
        409,
      );
    }
    await setBrowserSession(c, result.user.id, 0);
  } catch (error) {
    console.error('[registration] failed', error instanceof Error ? error.name : 'UnknownError');
    return showSignup(c, q, language, 'serviceUnavailable', username, email, 503);
  }
  deleteCookie(c, SIGNUP_FORM_COOKIE, { path: '/authorize' });
  const target = new URL(authorizationLink('/authorize', q, language), authIssuer());
  target.searchParams.set('registered', '1');
  return c.redirect(`${target.pathname}${target.search}`, 303);
});

authorizeRouter.post('/authorize/submit', async (c) => {
  const form = await c.req.parseBody();
  const str = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : '');
  const language = pageLanguage(str('lang'), c.req.header('accept-language'));
  const q = authorizationParams(form);
  const invalid = await validateAuthorizeParams(q);
  if (invalid) return c.json(invalid, 400);
  c.header('Content-Language', language);
  let identity = await getSessionFromCookie(c);
  if (!identity) {
    const username = str('username').trim();
    const password = str('password');
    if (!username || !password)
      return c.html(loginPage(q, language, await pageDetails(q), 'missingCredentials', username), 400);
    try {
      if (!(await limitLoginAccount(username))) {
        c.header('Retry-After', '900');
        return c.html(loginPage(q, language, await pageDetails(q), 'tooManyAttempts', username), 429);
      }
    } catch {
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    const user = await verifyUser(username, password);
    if (!user) return c.html(loginPage(q, language, await pageDetails(q), 'invalidCredentials', username), 401);
    identity = { sub: user.username, userId: user.id, userAuthVersion: user.authVersion };
    try {
      await setBrowserSession(c, user.id, user.authVersion);
    } catch {
      return c.html(loginPage(q, language, await pageDetails(q), 'invalidCredentials'), 401);
    }
  }
  const authorization = await getUserAuthorization(identity.userId);
  if (!authorization || authorization.disabled)
    return c.html(loginPage(q, language, await pageDetails(q), 'invalidCredentials'), 401);
  let code: string;
  try {
    code = await saveAuthCode({
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      scope: q.scope || 'mcp',
      code_challenge: q.code_challenge,
      resource: q.resource || undefined,
      ...identity,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  } catch {
    return c.html(loginPage(q, language, await pageDetails(q), 'invalidCredentials'), 401);
  }
  const target = new URL(q.redirect_uri);
  target.searchParams.set('code', code);
  if (q.state) target.searchParams.set('state', q.state);
  return c.redirect(target.toString(), 302);
});

async function getSessionFromCookie(c: Context): Promise<AuthIdentity | null> {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await getSessionUser(token) : null;
  if (!session) return null;
  const authorization = await getUserAuthorization(session.userId);
  return authorization && !authorization.disabled ? session : null;
}

async function setBrowserSession(c: Context, userId: number, userAuthVersion: number): Promise<void> {
  setCookie(c, SESSION_COOKIE, await createLoginSession(userId, userAuthVersion), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: authIssuer().startsWith('https://'),
    path: '/',
    maxAge: 7 * 24 * 3600,
  });
}

async function showSignup(
  c: Context,
  q: Record<string, string>,
  language: AuthPageLanguage,
  error?: AuthPageError,
  username = '',
  email = '',
  status: 200 | 400 | 403 | 409 | 429 | 503 = 200,
) {
  const token = randomBytes(32).toString('base64url');
  setCookie(c, SIGNUP_FORM_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: authIssuer().startsWith('https://'),
    path: '/authorize',
    maxAge: 15 * 60,
  });
  c.header('Content-Language', language);
  return c.html(signupPage(q, language, await pageDetails(q), token, error, username, email), status);
}

function resourceServer(resource: string | undefined): string | undefined {
  if (!resource) return undefined;
  try {
    const url = new URL(resource);
    if (url.origin !== new URL(gatewayPublicUrl()).origin) return undefined;
    return /^\/mcp\/([a-zA-Z0-9._-]{1,64})\/?$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

async function pageDetails(q: Record<string, string>): Promise<AuthPageDetails> {
  const client = await getClient(q.client_id);
  const name = resourceServer(q.resource);
  const [server] = name
    ? await db
        .select({ displayName: mcpServers.displayName })
        .from(mcpServers)
        .where(eq(mcpServers.name, name))
        .limit(1)
    : [];
  return { clientName: client?.client_name || q.client_id, resourceName: server?.displayName };
}

async function validateAuthorizeParams(
  q: Record<string, string>,
): Promise<{ error: string; error_description?: string } | null> {
  if (q.response_type !== 'code') return { error: 'unsupported_response_type' };
  const client = q.client_id ? await getClient(q.client_id) : undefined;
  if (!client) return { error: 'invalid_client', error_description: 'unknown client_id' };
  if (!q.redirect_uri || !isRedirectUriAllowed(client, q.redirect_uri))
    return { error: 'invalid_request', error_description: 'redirect_uri not registered' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '') || q.code_challenge_method !== 'S256') {
    return { error: 'invalid_request', error_description: 'PKCE with S256 is required' };
  }
  if (q.scope && !SCOPE_RE.test(q.scope)) return { error: 'invalid_scope' };
  if (q.resource) {
    try {
      new URL(q.resource);
    } catch {
      return { error: 'invalid_target' };
    }
  }
  return null;
}
