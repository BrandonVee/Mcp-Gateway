import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getClient, isRedirectUriAllowed } from './clients.js';
import { verifyUser, createLoginSession, getSessionUser } from './db.js';
import { saveAuthCode } from './stores.js';
import { loadPlatformConfig } from '@mcp/shared';
import { limitLoginAccount } from './rate-limit.js';

/**
 * Authorization Code + PKCE (S256) with real user authentication.
 *
 * GET /authorize         -> login page (or consent page if a valid session cookie exists)
 * POST /authorize/submit -> validates credentials, issues the code, 302 back to client
 */
export const authorizeRouter = new Hono();

const SCOPE_RE = /^[\x21\x23-\x5B\x5D-\x7E\s]*$/;
const SESSION_COOKIE = 'auth_session';
const SECURE_COOKIE = loadPlatformConfig().auth.issuer.startsWith('https://');
type AuthPageLanguage = 'zh-CN' | 'en-US';
type LoginError = 'missingCredentials' | 'invalidCredentials';

const pageText = {
  'zh-CN': {
    signInTitle: 'MCP Gateway - 登录', signInHeading: '登录并授权', client: '客户端',
    username: '用户名', password: '密码', signInSubmit: '登录并授权',
    consentTitle: 'MCP Gateway - 授权', consentHeading: '授权客户端',
    signedInAs: '当前用户：', requestsScope: '请求授权范围：', authorize: '确认授权',
    missingCredentials: '请输入用户名和密码。', invalidCredentials: '用户名或密码错误，或账号已停用。', languageMenu: '切换语言',
  },
  'en-US': {
    signInTitle: 'MCP Gateway - Sign in', signInHeading: 'Sign in to authorize', client: 'Client',
    username: 'Username', password: 'Password', signInSubmit: 'Sign in and authorize',
    consentTitle: 'MCP Gateway - Authorize', consentHeading: 'Authorize client',
    signedInAs: 'Signed in as:', requestsScope: 'requests scope:', authorize: 'Authorize',
    missingCredentials: 'Enter your username and password.', invalidCredentials: 'Invalid username or password, or account disabled.', languageMenu: 'Select language',
  },
} as const;

function pageLanguage(requested: string | undefined, acceptLanguage: string | undefined): AuthPageLanguage {
  if (requested === 'zh-CN' || requested === 'en-US') return requested;
  const preferences = (acceptLanguage ?? '').split(',').map((entry, index) => {
    const [tag, ...parameters] = entry.trim().split(';');
    const quality = parameters.find((parameter) => /^q=/i.test(parameter.trim()));
    const weight = quality ? Number(quality.trim().slice(2)) : 1;
    return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0, index };
  }).sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const preference of preferences) {
    if (preference.weight === 0) continue;
    if (/^zh(?:-|$)/.test(preference.tag)) return 'zh-CN';
    if (/^en(?:-|$)/.test(preference.tag)) return 'en-US';
  }
  return 'en-US';
}

authorizeRouter.get('/authorize', async (c) => {
  const q = c.req.query();
  const language = pageLanguage(q.lang, c.req.header('accept-language'));
  const error = await validateAuthorizeParams(q);
  if (error) return c.json(error, 400);

  c.header('Content-Language', language);
  const session = await getSessionFromCookie(c);
  if (session) {
    return c.html(consentPage(q, session.sub, language));
  }
  return c.html(loginPage(q, language));
});

authorizeRouter.post('/authorize/submit', async (c: Context) => {
  const form = await c.req.parseBody();
  const str = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');
  const language = pageLanguage(str('lang'), c.req.header('accept-language'));

  const q = {
    response_type: str('response_type'),
    client_id: str('client_id'),
    redirect_uri: str('redirect_uri'),
    code_challenge: str('code_challenge'),
    code_challenge_method: str('code_challenge_method'),
    scope: str('scope') || 'mcp',
    state: str('state'),
    resource: str('resource'),
  };
  const invalid = await validateAuthorizeParams(q);
  if (invalid) return c.json(invalid, 400);
  c.header('Content-Language', language);

  // Prefer an existing session; otherwise require username + password.
  let sub: string | undefined = (await getSessionFromCookie(c))?.sub;
  if (!sub) {
    const username = str('username').trim();
    const password = str('password');
    if (!username || !password) return c.html(loginPage(q, language, 'missingCredentials'), 400);
    try {
      if (!(await limitLoginAccount(username))) {
        c.header('Retry-After', '900');
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
    } catch {
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    const user = await verifyUser(username, password);
    if (!user) {
      return c.html(loginPage(q, language, 'invalidCredentials'), 401);
    }
    sub = user.username;
    // Keep the browser signed in for subsequent authorizations.
    setCookie(c, SESSION_COOKIE, await createLoginSession(sub), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: SECURE_COOKIE,
      path: '/',
      maxAge: 7 * 24 * 3600,
    });
  }

  const code = await saveAuthCode({
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    scope: q.scope,
    code_challenge: q.code_challenge,
    resource: q.resource || undefined,
    sub,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const target = new URL(q.redirect_uri);
  target.searchParams.set('code', code);
  if (q.state) target.searchParams.set('state', q.state);
  return c.redirect(target.toString(), 302);
});

async function getSessionFromCookie(c: Context): Promise<{ sub: string } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? await getSessionUser(token) : null;
}

async function validateAuthorizeParams(q: Record<string, string>): Promise<{ error: string; error_description?: string } | null> {
  if (q.response_type !== 'code') return { error: 'unsupported_response_type' };
  const client = q.client_id ? await getClient(q.client_id) : undefined;
  if (!client) return { error: 'invalid_client', error_description: 'unknown client_id' };
  if (!q.redirect_uri || !isRedirectUriAllowed(client, q.redirect_uri)) {
    return { error: 'invalid_request', error_description: 'redirect_uri not registered' };
  }
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

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hidden(name: string, value: string | undefined): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value ?? '')}">`;
}

const BASE_STYLE = `<style>
body{font-family:system-ui;max-width:24rem;margin:4rem auto;color:#222}
input{width:100%;padding:.5rem;margin:.25rem 0;box-sizing:border-box}
button{width:100%;padding:.6rem;margin-top:.75rem;background:#2563eb;color:#fff;border:0;border-radius:4px;font-size:1rem}
.small{color:#777;font-size:.85rem}
.language-links{text-align:right;font-size:.85rem}.language-links a{margin-left:.7rem;color:#2563eb}
.form-error{padding:.65rem;background:#fff0f0;color:#a32626;border-radius:4px}
</style>`;

function hiddenFields(q: Record<string, string>, language: AuthPageLanguage): string {
  return [
    hidden('lang', language),
    hidden('response_type', q.response_type),
    hidden('client_id', q.client_id),
    hidden('redirect_uri', q.redirect_uri),
    hidden('scope', q.scope),
    hidden('state', q.state),
    hidden('code_challenge', q.code_challenge),
    hidden('code_challenge_method', q.code_challenge_method),
    hidden('resource', q.resource),
  ].join('\n  ');
}

function languageLinks(q: Record<string, string>, language: AuthPageLanguage): string {
  const link = (target: AuthPageLanguage, label: string) => {
    const params = new URLSearchParams(q);
    params.set('lang', target);
    return target === language ? `<strong>${label}</strong>` : `<a href="${esc(`/authorize?${params.toString()}`)}">${label}</a>`;
  };
  return `<nav class="language-links" aria-label="${pageText[language].languageMenu}">${link('zh-CN', '中文')}${link('en-US', 'English')}</nav>`;
}

function loginPage(q: Record<string, string>, language: AuthPageLanguage, error?: LoginError): string {
  const copy = pageText[language];
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><title>${copy.signInTitle}</title>${BASE_STYLE}</head><body>
${languageLinks(q, language)}
<h3>${copy.signInHeading}</h3>
<p class="small">${copy.client}: ${esc(q.client_id ?? '')}</p>
${error ? `<p class="form-error" role="alert">${copy[error]}</p>` : ''}
<form method="post" action="/authorize/submit">
  ${hiddenFields(q, language)}
  <label>${copy.username} <input name="username" autocomplete="username" required></label>
  <label>${copy.password} <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">${copy.signInSubmit}</button>
</form>
</body></html>`;
}

function consentPage(q: Record<string, string>, user: string, language: AuthPageLanguage): string {
  const copy = pageText[language];
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><title>${copy.consentTitle}</title>${BASE_STYLE}</head><body>
${languageLinks(q, language)}
<h3>${copy.consentHeading}</h3>
<p>${copy.signedInAs} <b>${esc(user)}</b></p>
<p class="small">${copy.client} ${esc(q.client_id ?? '')} ${copy.requestsScope} "${esc(q.scope ?? 'mcp')}"</p>
<form method="post" action="/authorize/submit">
  ${hiddenFields(q, language)}
  <button type="submit">${copy.authorize}</button>
</form>
</body></html>`;
}
