import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getClient, isRedirectUriAllowed } from './clients.js';
import { verifyUser, createLoginSession, getSessionUser } from './db.js';
import { saveAuthCode } from './stores.js';
import { loadPlatformConfig } from '@mcp/shared';

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

authorizeRouter.get('/authorize', async (c) => {
  const q = c.req.query();
  const error = await validateAuthorizeParams(q);
  if (error) return c.json(error, 400);

  const session = await getSessionFromCookie(c);
  if (session) {
    return c.html(consentPage(q, session.sub));
  }
  return c.html(loginPage(q));
});

authorizeRouter.post('/authorize/submit', async (c: Context) => {
  const form = await c.req.parseBody();
  const str = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');

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

  // Prefer an existing session; otherwise require username + password.
  let sub: string | undefined = (await getSessionFromCookie(c))?.sub;
  if (!sub) {
    const username = str('username').trim();
    const password = str('password');
    if (!username || !password) return c.json({ error: 'invalid_request', error_description: 'username and password are required' }, 400);
    const user = await verifyUser(username, password);
    if (!user) {
      return c.json({ error: 'access_denied', error_description: 'invalid username or password, or account disabled' }, 401);
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
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
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
</style>`;

function hiddenFields(q: Record<string, string>): string {
  return [
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

function loginPage(q: Record<string, string>): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Auth Server - Sign in</title>${BASE_STYLE}</head><body>
<h3>Sign in to authorize</h3>
<p class="small">Client: ${esc(q.client_id ?? '')}</p>
<form method="post" action="/authorize/submit">
  ${hiddenFields(q)}
  <label>Username <input name="username" autocomplete="username" required></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in &amp; Authorize</button>
</form>
</body></html>`;
}

function consentPage(q: Record<string, string>, user: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Auth Server - Authorize</title>${BASE_STYLE}</head><body>
<h3>Authorize client</h3>
<p>Signed in as <b>${esc(user)}</b>.</p>
<p class="small">Client ${esc(q.client_id ?? '')} requests scope "${esc(q.scope ?? 'mcp')}".</p>
<form method="post" action="/authorize/submit">
  ${hiddenFields(q)}
  <button type="submit">Authorize</button>
</form>
</body></html>`;
}
