/** Verify self-registration against a disposable local Auth/Gateway stack. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const AUTH = process.env.AUTH_URL ?? 'http://localhost:9001';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8000';
for (const base of [AUTH, GATEWAY]) {
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Run signup smoke tests only against a disposable local stack');
}
const suffix = randomBytes(5).toString('hex');
const defaultName = `signup-${suffix}`;
const privateName = `manual-${suffix}`;
const pausedName = `paused-${suffix}`;
const firstUsername = `new-${suffix}`;
const secondUsername = `later-${suffix}`;
const password = 'signup-test-password-123';
let adminCookie = '';
const cookie = (response: Response, name: string) => response.headers.getSetCookie()
  .map((value) => value.split(';')[0]).find((value) => value.startsWith(`${name}=`)) ?? '';
const hiddenFields = (html: string) => new URLSearchParams([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)]
  .map((match) => [match[1], match[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
async function admin(path: string, method = 'GET', body?: unknown) {
  return fetch(`${AUTH}/admin${path}`, {
    method, redirect: 'manual', headers: { cookie: adminCookie, origin: new URL(AUTH).origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const upstream = createServer((_req, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'signup-test', version: '1' } } }));
});

async function main() {
  if (!process.env.ADMIN_PASSWORD) throw new Error('Set ADMIN_PASSWORD for the disposable local stack');
  await new Promise<void>((done) => upstream.listen(0, '0.0.0.0', done));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  // Containerized gateways can use host.docker.internal; native ones use loopback.
  const upstreamHost = process.env.SIGNUP_UPSTREAM_HOST ?? '127.0.0.1';
  const upstreamUrl = `http://${upstreamHost}:${address.port}/mcp`;
  const login = await admin('/session', 'POST', { username: 'admin', password: process.env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  adminCookie = cookie(login, 'auth_session');
  assert.ok(adminCookie);
  try {
    for (const [name, signup_access] of [[defaultName, true], [privateName, false], [pausedName, true]] as const) {
      const created = await admin('/servers', 'POST', { name, display_name: name, signup_access, auth_mode: 'none', instances: [{ url: upstreamUrl }] });
      assert.equal(created.status, 201, await created.text());
    }
    assert.equal((await admin(`/servers/${pausedName}`, 'PATCH', { enabled: false })).status, 200);
    assert.equal((await admin(`/servers/${defaultName}/users`, 'PUT', { user_ids: [], signup_access: 'false' })).status, 400);
    assert.equal((await admin(`/servers/${defaultName}/users`, 'PUT', { user_ids: [], signup_access: false })).status, 200);
    assert.equal((await (await admin(`/servers/${defaultName}/users`)).json()).signup_access, false);
    assert.equal((await admin(`/servers/${defaultName}/users`, 'PUT', { user_ids: [], signup_access: true })).status, 200);
    const redirectUri = 'http://127.0.0.1:55945/oauth/callback';
    const clientResponse = await fetch(`${AUTH}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'WorkBuddy', redirect_uris: [redirectUri] }),
    });
    assert.equal(clientResponse.status, 201,
      clientResponse.status === 201 ? undefined : await clientResponse.text());
    const client = await clientResponse.json();
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      state: `signup-state-${suffix}`, scope: 'mcp', resource: `${GATEWAY}/mcp/${defaultName}`, lang: 'zh-CN',
    });
    const authorizeUrl = `${AUTH}/authorize?${q}`;
    if (process.env.MCP_SIGNUP_PREVIEW_FILE) writeFileSync(process.env.MCP_SIGNUP_PREVIEW_FILE, authorizeUrl);
    const loginPage = await fetch(authorizeUrl);
    assert.equal(loginPage.status, 200);
    assert.equal(loginPage.headers.get('cache-control'), 'no-store');
    const loginHtml = await loginPage.text();
    assert.ok(loginHtml.includes('创建账号'));
    assert.ok(loginHtml.includes('WorkBuddy'));
    const signupUrl = `${AUTH}/authorize/signup?${q}`;
    const signupForm = async (username = firstUsername, confirmation = password) => {
      const page = await fetch(signupUrl);
      assert.equal(page.status, 200);
      const html = await page.text();
      const body = hiddenFields(html);
      body.set('username', username);
      body.set('password', password);
      body.set('confirm_password', confirmation);
      // None of these caller-supplied privilege fields may affect registration.
      body.set('role', 'admin'); body.set('all_servers', 'true'); body.set('servers', '*');
      return { body, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie(page, 'mcp_signup_form'), origin: new URL(AUTH).origin } };
    };
    const missingCsrf = await signupForm();
    missingCsrf.body.delete('form_token');
    assert.equal((await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...missingCsrf, redirect: 'manual' })).status, 403);
    const malformedCsrf = await signupForm();
    malformedCsrf.headers.cookie = `mcp_signup_form=${encodeURIComponent('界'.repeat(43))}`;
    assert.equal((await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...malformedCsrf, redirect: 'manual' })).status, 403);
    const crossOrigin = await signupForm();
    crossOrigin.headers.origin = 'https://attacker.example.test';
    assert.equal((await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...crossOrigin, redirect: 'manual' })).status, 403);
    const mismatch = await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...await signupForm(firstUsername, 'wrong-confirmation'), redirect: 'manual' });
    assert.equal(mismatch.status, 400);
    const mismatchHtml = await mismatch.text();
    assert.ok(mismatchHtml.includes('两次输入的密码不一致'));
    assert.equal(mismatchHtml.includes(password), false);
    const signup = await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...await signupForm(), redirect: 'manual' });
    assert.equal(signup.status, 303, await signup.text());
    const registeredCookie = cookie(signup, 'auth_session');
    assert.ok(registeredCookie);
    const continuation = new URL(signup.headers.get('location')!, AUTH);
    for (const [key, value] of q) assert.equal(continuation.searchParams.get(key), value, key);
    assert.equal(continuation.pathname, '/authorize');
    const consent = await fetch(continuation, { headers: { cookie: registeredCookie } });
    const consentHtml = await consent.text();
    assert.ok(consentHtml.includes('账号已创建'));
    assert.ok(consentHtml.includes(firstUsername));
    assert.equal(consentHtml.includes('需要管理员开通访问权限'), false);
    const exchange = async (resource: string) => {
      const form = new URLSearchParams(q);
      form.set('resource', resource);
      const authorized = await fetch(`${AUTH}/authorize/submit`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: registeredCookie }, body: form, redirect: 'manual',
      });
      assert.equal(authorized.status, 302);
      const callback = new URL(authorized.headers.get('location')!);
      assert.equal(callback.searchParams.get('state'), q.get('state'));
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code: callback.searchParams.get('code')!, code_verifier: verifier });
      const tokens = await fetch(`${AUTH}/token`, { method: 'POST', body });
      assert.equal(tokens.status, 200);
      const token = (await tokens.json()).access_token as string;
      const replay = await fetch(`${AUTH}/token`, { method: 'POST', body });
      assert.equal(replay.status, 400, 'authorization code cannot be reused');
      return token;
    };
    const token = await exchange(`${GATEWAY}/mcp/${defaultName}`);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.equal(claims.role, 'user');
    assert.equal(claims.aud, q.get('resource'));
    assert.deepEqual(claims.mcp_servers, [defaultName]);
    assert.equal((await fetch(`${AUTH}/admin/servers`, { headers: { cookie: registeredCookie } })).status, 403);
    const duplicate = await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...await signupForm(), redirect: 'manual' });
    assert.equal(duplicate.status, 409);
    const directoryToken = await exchange(GATEWAY);
    const headers = { authorization: `Bearer ${directoryToken}`, 'content-type': 'application/json' };
    const initialized = await fetch(`${GATEWAY}/mcp/${defaultName}`, { method: 'POST', headers, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
    assert.equal(initialized.status, 200, await initialized.text());
    assert.equal((await fetch(`${GATEWAY}/mcp/${privateName}`, { method: 'POST', headers, body: '{}' })).status, 403);
    console.log('PASS: signup, CSRF, validation, session, consent, PKCE callback, token exchange, default grants, and Gateway access');

    assert.equal((await admin(`/servers/${defaultName}/users`, 'PUT', { user_ids: [claims.uid], signup_access: false })).status, 200);
    const later = await fetch(`${AUTH}/authorize/signup`, { method: 'POST', ...await signupForm(secondUsername), redirect: 'manual' });
    assert.equal(later.status, 303);
    const laterCookie = cookie(later, 'auth_session');
    const laterConsent = await fetch(new URL(later.headers.get('location')!, AUTH), { headers: { cookie: laterCookie } });
    assert.ok((await laterConsent.text()).includes('需要管理员开通访问权限'));
    const users = (await (await admin('/users')).json()).users as Array<{ id: number; username: string; servers: string[] }>;
    assert.deepEqual(users.find((user) => user.username === firstUsername)?.servers, [defaultName]);
    assert.deepEqual(users.find((user) => user.username === secondUsername)?.servers, []);
    assert.equal((await admin(`/servers/${privateName}/users`, 'PUT', { user_ids: [claims.uid] })).status, 200);
    const afterGrant = (await (await admin('/users')).json()).users as typeof users;
    assert.deepEqual(afterGrant.find((user) => user.username === firstUsername)?.servers.sort(), [defaultName, privateName].sort());
    console.log('PASS: changing signup defaults affects future registrations, preserves existing access, and supports manual grants');
    let limited = false;
    for (let attempt = 0; attempt < 11; attempt++) {
      const probe = await fetch(`${AUTH}/authorize/signup`, {
        method: 'POST', ...await signupForm(`rate-${suffix}`, 'wrong-confirmation'), redirect: 'manual',
      });
      if (probe.status === 429) {
        assert.equal(probe.headers.get('retry-after'), '3600');
        limited = true;
        break;
      }
      assert.equal(probe.status, 400);
    }
    assert.ok(limited, 'public signup is rate-limited per client IP');
    console.log('PASS: public signup rate limits and retry headers');
  } finally {
    if (adminCookie) {
      const users = (await (await admin('/users')).json()).users as Array<{ id: number; username: string }>;
      for (const user of users.filter((user) => [firstUsername, secondUsername].includes(user.username))) await admin(`/users/${user.id}`, 'DELETE');
      for (const name of [defaultName, privateName, pausedName]) await admin(`/servers/${name}`, 'DELETE');
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => upstream.close());
