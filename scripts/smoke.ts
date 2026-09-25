/**
 * End-to-end smoke test against a running stack (Compose or pnpm dev:local):
 *
 *   1. discovery: RFC 9728 protected-resource metadata + RFC 8414 auth-server metadata
 *   2. OAuth: use pre-registered "demo-client", do authorization-code + PKCE
 *      (simulates the browser login POST), exchange the code for tokens
 *   3. MCP via gateway: initialize -> tools/list -> tools/call "server_info" x4
 *      (alternating instance ids proves round-robin load balancing)
 */
import { createHash, randomBytes } from 'node:crypto';

const GW = process.env.GATEWAY_URL ?? 'http://localhost:8000';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:9001';
const REPORTS_UPSTREAM_URL = process.env.REPORTS_UPSTREAM_URL ?? 'http://localhost:3003';
const CLIENT_ID = 'demo-client';
const REDIRECT_URI = 'http://localhost:8080/callback';

// Retry transient connection errors (real clients do this too).
const rawFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawFetch(input, init);
    } catch (err: any) {
      const code = err?.cause?.code;
      if (attempt < 2 && (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
        console.error('[smoke] fetch failed after retries:', typeof input === 'string' ? input : input.url, code);
      }
      throw err;
    }
  }
}) as typeof fetch;

/** The SDK may answer with a plain JSON body or an SSE stream; handle both. */
async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    return JSON.parse(dataLines[dataLines.length - 1]);
  }
  return JSON.parse(text);
}


function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  // --- 1. discovery ---------------------------------------------------------
  const [authLive, authReady, gatewayLive, gatewayReady] = await Promise.all([
    fetch(`${AUTH}/live`), fetch(`${AUTH}/health`), fetch(`${GW}/live`), fetch(`${GW}/health`),
  ]);
  check('auth liveness and readiness', authLive.status === 200 && authReady.status === 200);
  check('gateway liveness and readiness', gatewayLive.status === 200 && gatewayReady.status === 200);

  const prMeta = await fetch(`${GW}/.well-known/oauth-protected-resource`).then((r) => r.json());
  check('protected-resource metadata', prMeta.authorization_servers?.[0] === AUTH, `auth server: ${prMeta.authorization_servers?.[0]}`);
  const demoMeta = await fetch(`${GW}/.well-known/oauth-protected-resource/mcp/demo`).then((r) => r.json());
  check('server-specific resource metadata', demoMeta.resource === `${GW}/mcp/demo`, `resource: ${demoMeta.resource}`);

  const asMeta = await fetch(`${AUTH}/.well-known/oauth-authorization-server`).then((r) => r.json());
  check('authorization-server metadata', asMeta.issuer === AUTH && asMeta.code_challenge_methods_supported?.includes('S256'));

  // --- 2. OAuth authorization code + PKCE ----------------------------------
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');

  const authorizeUrl = new URL(`${AUTH}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', 'mcp');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  // Simulate the client (no token -> 401 with resource_metadata from the gateway):
  const gwUnauthorized = await fetch(`${GW}/mcp/demo`, { method: 'POST', body: '{}' });
  check(
    'gateway rejects anonymous request (401)',
    gwUnauthorized.status === 401 && (gwUnauthorized.headers.get('www-authenticate') ?? '').includes('resource_metadata'),
  );

  // Browser flow: GET /authorize renders the login form.
  const loginPage = await fetch(authorizeUrl).then((r) => r.text());
  const hidden = [...loginPage.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  check('authorize form rendered in English', loginPage.includes('Sign in to authorize') && loginPage.includes('<html lang="en-US">') && hidden.some(([k]) => k === 'code_challenge'));
  const zhLoginResponse = await fetch(authorizeUrl, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
  const zhLoginPage = await zhLoginResponse.text();
  check('authorize form follows Chinese browser language', zhLoginResponse.headers.get('content-language') === 'zh-CN' && zhLoginPage.includes('登录并授权'));
  const weightedLanguagePage = await fetch(authorizeUrl, { headers: { 'accept-language': 'en-US;q=0.2,zh-CN;q=0.9' } }).then((r) => r.text());
  check('authorize form honors language quality values', weightedLanguagePage.includes('<html lang="zh-CN">'));
  const explicitEnglishUrl = new URL(authorizeUrl);
  explicitEnglishUrl.searchParams.set('lang', 'en-US');
  const explicitEnglishPage = await fetch(explicitEnglishUrl, { headers: { 'accept-language': 'zh-CN' } }).then((r) => r.text());
  check('authorize language selection overrides browser language', explicitEnglishPage.includes('<html lang="en-US">'));
  const badChineseForm = new URLSearchParams(hidden.map(([key, value]) => [key, value] as [string, string]));
  badChineseForm.set('lang', 'zh-CN');
  badChineseForm.set('username', 'demo-user');
  badChineseForm.set('password', 'wrong-password');
  const badChineseResponse = await fetch(`${AUTH}/authorize/submit`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: badChineseForm,
  });
  check('authorize login error is localized', badChineseResponse.status === 401 && (await badChineseResponse.text()).includes('用户名或密码错误'));

  const injectionState = '"><img src=x onerror=alert(1)>';
  const injectionUrl = new URL(authorizeUrl);
  injectionUrl.searchParams.set('state', injectionState);
  const injectionLoginPage = await fetch(injectionUrl).then((r) => r.text());
  const escapedState = 'name="state" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"';
  check('authorize login page escapes hidden fields', injectionLoginPage.includes(escapedState) && !injectionLoginPage.includes('<img'));

  // Submit login -> 302 with ?code=...
  const form = new URLSearchParams(hidden.map(([k, v]) => [k, v] as [string, string]));
  form.set('username', 'demo-user');
  form.set('password', 'demo123');
  const submit = await fetch(`${AUTH}/authorize/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const location = submit.headers.get('location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';
  check('authorization code issued', submit.status === 302 && code.length > 0 && new URL(location).searchParams.get('state') === state);

  const sessionCookie = submit.headers.get('set-cookie')?.split(';', 1)[0];
  const injectionConsentPage = await fetch(injectionUrl, { headers: { cookie: sessionCookie ?? '' } }).then((r) => r.text());
  check('authorize consent page escapes hidden fields', !!sessionCookie && injectionConsentPage.includes(escapedState) && !injectionConsentPage.includes('<img'));
  const zhConsentPage = await fetch(authorizeUrl, { headers: { cookie: sessionCookie ?? '', 'accept-language': 'zh-CN' } }).then((r) => r.text());
  check('authorize consent page is localized', zhConsentPage.includes('授权客户端') && zhConsentPage.includes('<html lang="zh-CN">'));

  // Exchange code + verifier for tokens.
  const tokenRes = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
  check('token endpoint returned access token', tokens.token_type === 'Bearer' && !!tokens.access_token);

  const payload = JSON.parse(Buffer.from(tokens.access_token!.split('.')[1], 'base64url').toString());
  check(
    'JWT claims and server grants',
    payload.iss === AUTH && payload.sub === 'demo-user' && payload.aud === 'mcp-gateway' && payload.mcp_servers?.includes('demo'),
    `sub=${payload.sub} aud=${payload.aud} servers=${payload.mcp_servers?.join(',')}`,
  );

  const visibleServers = (await (await fetch(`${GW}/servers`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as {
    servers: { name: string }[];
  };
  check(
    'server directory is filtered by grants',
    visibleServers.servers.length === 1 && visibleServers.servers[0].name === 'demo',
    visibleServers.servers.map((server) => server.name).join(','),
  );

  const refreshRes = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: CLIENT_ID,
    }),
  });
  const refreshed = (await refreshRes.json()) as { access_token?: string; refresh_token?: string };
  check('refresh token rotation', refreshRes.status === 200 && !!refreshed.access_token && !!refreshed.refresh_token);
  const reusedRefresh = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: CLIENT_ID,
    }),
  });
  check('used refresh token is rejected', reusedRefresh.status === 400 && (await reusedRefresh.json()).error === 'invalid_grant');

  // Wrong PKCE verifier must fail.
  const badRes = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier12',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });
  check('PKCE rejects wrong verifier', badRes.status === 400 && (await badRes.json()).error === 'invalid_grant');

  // --- 3. MCP through the gateway -------------------------------------------
  const mcpHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream', // required by the MCP SDK
    authorization: `Bearer ${tokens.access_token}`,
  };

  const initRes = await fetch(`${GW}/mcp/demo`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' },
      },
    }),
  });
  const sessionId = initRes.headers.get('mcp-session-id');
  const initBody = await readJson(initRes);
  check('initialize via gateway', initBody?.result?.serverInfo?.name === 'demo', `server=${initBody?.result?.serverInfo?.name} session=${sessionId?.slice(0, 8)}...`);

  const rpc = async (method: string, params: object, id: number) =>
    readJson(
      await fetch(`${GW}/mcp/demo`, {
        method: 'POST',
        headers: { ...mcpHeaders, 'mcp-session-id': sessionId! },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
    );

  await rpc('notifications/initialized', {}, 0).catch(() => {});

  const tools = await rpc('tools/list', {}, 2);
  const toolNames = (tools?.result?.tools ?? []).map((t: { name: string }) => t.name);
  check('tools/list', ['server_info', 'echo', 'add'].every((n) => toolNames.includes(n)), toolNames.join(', '));

  const add = await rpc('tools/call', { name: 'add', arguments: { a: 20, b: 22 } }, 3);
  check('tools/call add(20,22)', add?.result?.content?.[0]?.text === '42');

  // Session stickiness: every call inside one session hits the same instance.
  const sticky = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = await rpc('tools/call', { name: 'server_info', arguments: {} }, 10 + i);
    const info = JSON.parse(r?.result?.content?.[0]?.text ?? '{}');
    sticky.add(info.instance);
  }
  check('session stickiness (same instance)', sticky.size === 1, `seen: ${[...sticky].join(', ')}`);

  // Load balancing: fresh sessions should spread across instances (round-robin).
  const allInstances = new Set<string>(...[sticky]);
  let lbPass = false;
  for (let round = 0; round < 3 && !lbPass; round++) {
    for (let i = 0; i < 3; i++) {
      const i2 = await fetch(`${GW}/mcp/demo`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 50 + round * 10 + i,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `smoke-${round}-${i}`, version: '0.0.0' } },
        }),
      });
      const r2 = await readJson(
        await fetch(`${GW}/mcp/demo`, {
          method: 'POST',
          headers: { ...mcpHeaders, 'mcp-session-id': i2.headers.get('mcp-session-id')! },
          body: JSON.stringify({ jsonrpc: '2.0', id: 60 + round * 10 + i, method: 'tools/call', params: { name: 'server_info', arguments: {} } }),
        }),
      );
      allInstances.add(JSON.parse(r2?.result?.content?.[0]?.text ?? '{}').instance);
    }
    lbPass = allInstances.size > 1;
  }
  check('load balancing across instances', lbPass, `seen: ${[...allInstances].join(', ')}`);

  // Unauthenticated request with a garbage token must be rejected.
  const bad = await fetch(`${GW}/mcp/demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
  });
  check('gateway rejects bad token (401)', bad.status === 401);

  // --- 4. admin bootstrap & user management --------------------------------
  const pkceLogin = async (username: string, password: string): Promise<{ submit: Response; verifier: string }> => {
    const verifier = randomBytes(32).toString('base64url');
    const ch = createHash('sha256').update(verifier).digest('base64url');
    const page = await (await fetch(`${AUTH}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=mcp&state=x&code_challenge=${ch}&code_challenge_method=S256`)).text();
    const hidden = [...page.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]] as [string, string]);
    const form = new URLSearchParams([...hidden, ['username', username], ['password', password]]);
    const submit = await fetch(`${AUTH}/authorize/submit`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
    return { submit, verifier };
  };
  const exchangeCode = async (code: string, verifier: string): Promise<{ access_token?: string }> =>
    (await (
      await fetch(`${AUTH}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }),
      })
    ).json()) as { access_token?: string };

  const badLogin = await pkceLogin('demo-user', 'wrong-password');
  check('wrong password rejected (401)', badLogin.submit.status === 401);

  const adminFlow = await pkceLogin('admin', process.env.ADMIN_PASSWORD ?? 'admin123');
  check('admin login (bootstrap account)', adminFlow.submit.status === 302, `status ${adminFlow.submit.status}`);
  const adminToken =
    (await exchangeCode(new URL(adminFlow.submit.headers.get('location') ?? '').searchParams.get('code') ?? '', adminFlow.verifier)).access_token ?? '';
  const adminClaims = JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64url').toString());
  check('admin JWT carries role=admin', adminClaims.role === 'admin', `role=${adminClaims.role}`);
  const adminPersonalSession = await fetch(`${AUTH}/me/session`, {
    headers: { cookie: adminFlow.submit.headers.get('set-cookie')?.split(';', 1)[0] ?? '' },
  });
  const adminPersonalData = await adminPersonalSession.json() as { role?: string };
  check('connection center identifies administrator for console link', adminPersonalSession.status === 200 && adminPersonalData.role === 'admin');
  const crossOriginAdminWrite = await fetch(`${AUTH}/admin/users`, {
    method: 'POST',
    headers: { origin: 'https://untrusted.example', authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'blocked', password: 'blocked-password', role: 'user' }),
  });
  check('admin API rejects cross-origin browser writes', crossOriginAdminWrite.status === 403);
  const explicitBadBearer = await fetch(`${AUTH}/admin/session`, {
    headers: { authorization: 'Bearer invalid', cookie: adminFlow.submit.headers.get('set-cookie')?.split(';')[0] ?? '' },
  });
  check('invalid bearer does not fall back to admin cookie', explicitBadBearer.status === 401);
  const stolenSession = await fetch(`${GW}/mcp/demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, 'mcp-session-id': sessionId! },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }),
  });
  check('MCP session cannot be reused by a different user', stolenSession.status === 404);

  const aliceName = `alice-${randomBytes(3).toString('hex')}`; // unique per run (parallel-safe)
  const createRes = await fetch(`${AUTH}/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: aliceName, password: 'alice-pass-1', role: 'user' }),
  });
  check('admin creates user via API', createRes.status === 201 || createRes.status === 409, `status ${createRes.status}`);
  const auditRes = await fetch(`${AUTH}/admin/audit-events?limit=20&actor=admin&method=POST`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const auditBody = await auditRes.json() as { events?: Array<{ path: string; status_code: number; request_id: string }> };
  check('admin audit records metadata without request secrets', auditRes.status === 200 &&
    Boolean(auditBody.events?.some((event) => event.path === '/admin/users' && event.status_code === createRes.status && event.request_id)) &&
    !JSON.stringify(auditBody).includes('alice-pass-1'));
  const invalidAuditPage = await fetch(`${AUTH}/admin/audit-events?limit=500`, { headers: { authorization: `Bearer ${adminToken}` } });
  check('audit API validates pagination', invalidAuditPage.status === 400);
  if (createRes.status === 409) {
    const all = (await (await fetch(`${AUTH}/admin/users`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { users: { id: number; username: string }[] };
    const existing = all.users.find((u) => u.username === aliceName);
    await fetch(`${AUTH}/admin/users/${existing!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ password: 'alice-pass-1', disabled: false }),
    });
  }

  const aliceFlow = await pkceLogin(aliceName, 'alice-pass-1');
  check('new user can log in', aliceFlow.submit.status === 302);
  const aliceToken =
    (await exchangeCode(new URL(aliceFlow.submit.headers.get('location') ?? '').searchParams.get('code') ?? '', aliceFlow.verifier)).access_token ?? '';
  const aliceInit = await fetch(`${GW}/mcp/demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'alice', version: '0' } } }),
  });
  check('unassigned user is denied (403)', aliceInit.status === 403);

  const allUsers = (await (await fetch(`${AUTH}/admin/users`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as {
    users: { id: number; username: string; servers: string[] }[];
  };
  const aliceId = allUsers.users.find((u) => u.username === aliceName)!.id;
  const externalServerName = `external-${randomBytes(3).toString('hex')}`;
  const externalCreate = await fetch(`${AUTH}/admin/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: externalServerName,
      display_name: 'External smoke server',
      instances: [{ id: `${externalServerName}-a`, url: `${REPORTS_UPSTREAM_URL}/mcp-protected` }],
      auth_mode: 'api_key',
      api_key_header: 'x-api-key',
      api_key_prefix: '',
    }),
  });
  check('admin registers external MCP endpoint', externalCreate.status === 201, `status ${externalCreate.status}`);
  const oauthServerName = `oauth-${randomBytes(3).toString('hex')}`;
  const oauthRedirectUri = `${AUTH}/oauth/callback/${oauthServerName}`;
  const oauthClientRegistration = await fetch(`${AUTH}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'OAuth smoke connector', redirect_uris: [oauthRedirectUri] }),
  });
  const oauthClient = await oauthClientRegistration.json() as { client_id?: string };
  check('OAuth fixture client registered', oauthClientRegistration.status === 201 && !!oauthClient.client_id);
  const oauthCreate = await fetch(`${AUTH}/admin/servers`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: oauthServerName, display_name: 'OAuth smoke server',
      instances: [{ id: `${oauthServerName}-a`, url: `${REPORTS_UPSTREAM_URL}/mcp-oauth` }],
      auth_mode: 'oauth', oauth_authorize_url: `${AUTH}/authorize`, oauth_token_url: `${AUTH}/token`, oauth_client_id: oauthClient.client_id,
      oauth_issuer: AUTH,
    }),
  });
  check('admin registers OAuth-protected MCP endpoint', oauthCreate.status === 201);
  const grantRes = await fetch(`${AUTH}/admin/users/${aliceId}/servers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ servers: ['reports', externalServerName, oauthServerName] }),
  });
  check('admin assigns built-in and external servers', grantRes.status === 200);

  // A newly issued JWT carries the updated grants. Existing short-lived JWTs
  // retain their snapshot until expiry.
  const aliceGrantedFlow = await pkceLogin(aliceName, 'alice-pass-1');
  const aliceGrantedToken =
    (await exchangeCode(
      new URL(aliceGrantedFlow.submit.headers.get('location') ?? '').searchParams.get('code') ?? '',
      aliceGrantedFlow.verifier,
    )).access_token ?? '';
  const aliceClaims = JSON.parse(Buffer.from(aliceGrantedToken.split('.')[1], 'base64url').toString());
  check('assigned servers are embedded in JWT', aliceClaims.mcp_servers?.join(',') === `${externalServerName},${oauthServerName},reports`);

  const reportsInit = await fetch(`${GW}/mcp/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'alice', version: '0' } } }),
  });
  check('assigned user connects to reports entrance', reportsInit.status === 200);
  const reportsUsersUrl = `${AUTH}/admin/servers/reports/users`;
  const reportsUsers = await fetch(reportsUsersUrl, { headers: { authorization: `Bearer ${adminToken}` } });
  const reportsGrantIds = (await reportsUsers.json() as { user_ids: number[] }).user_ids;
  check('admin can inspect Server user grants', reportsUsers.status === 200 && reportsGrantIds.includes(aliceId));
  const invalidGrant = await fetch(reportsUsersUrl, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ user_ids: ['invalid'] }),
  });
  check('Server grants reject invalid user IDs', invalidGrant.status === 400);
  const updateReportsUsers = (user_ids: number[]) => fetch(reportsUsersUrl, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ user_ids }),
  });
  const removedReportsGrant = await updateReportsUsers(reportsGrantIds.filter((id) => id !== aliceId));
  const revokedReportsAccess = await fetch(`${GW}/mcp/reports`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }),
  });
  check('removing a Server grant blocks an existing token', removedReportsGrant.status === 200 && revokedReportsAccess.status === 403);
  const restoredReportsGrant = await updateReportsUsers(reportsGrantIds);
  check('admin can restore Server grants', restoredReportsGrant.status === 200);
  const externalInitRequest = () => fetch(`${GW}/mcp/${externalServerName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'external-smoke', version: '0' } } }),
  });
  const missingConnection = await externalInitRequest();
  check('external server requires personal credential', missingConnection.status === 409);

  const personalLogin = await fetch(`${AUTH}/me/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: aliceName, password: 'alice-pass-1' }),
  });
  const personalCookie = personalLogin.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const personalSessionData = await personalLogin.json() as { role?: string };
  check('user signs in to connection center without admin access', personalLogin.status === 200 && !!personalCookie && personalSessionData.role === 'user');
  const badOrigin = await fetch(`${AUTH}/me/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' },
    body: JSON.stringify({ username: aliceName, password: 'alice-pass-1' }),
  });
  check('connection center rejects cross-origin writes', badOrigin.status === 403);
  await fetch(`${AUTH}/me/servers/${externalServerName}/credential`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: JSON.stringify({ api_key: 'wrong-key' }),
  });
  const rejectedUpstreamKey = await externalInitRequest();
  check('upstream API key rejection does not trigger platform OAuth', rejectedUpstreamKey.status === 409 && (await rejectedUpstreamKey.json()).error === 'upstream_credential_rejected');
  const saveKey = await fetch(`${AUTH}/me/servers/${externalServerName}/credential`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: JSON.stringify({ api_key: 'smoke-user-key' }),
  });
  check('user saves an encrypted personal API key', saveKey.status === 200);
  const connectionList = await fetch(`${AUTH}/me/servers`, { headers: { cookie: personalCookie } }).then((res) => res.json()) as {
    servers: Array<{ name: string; connection_status: string; api_key?: string }>;
  };
  check('connection status is visible without exposing key', connectionList.servers.some((server) => server.name === externalServerName && server.connection_status === 'connected' && !server.api_key));
  const adminWithoutKey = await fetch(`${GW}/mcp/${externalServerName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
  });
  check('personal API key is isolated from another user', adminWithoutKey.status === 409);
  const externalInit = await externalInitRequest();
  check('gateway discovers and connects to external server', externalInit.status === 200);
  const adminConnectionList = await fetch(`${AUTH}/admin/connections`, { headers: { authorization: `Bearer ${adminToken}` } });
  const adminConnectionBody = await adminConnectionList.text();
  const adminConnectionData = JSON.parse(adminConnectionBody) as { connections: Array<{ user_id: number; server_name: string; mode: string }> };
  check('admin sees connection metadata without API key', adminConnectionList.status === 200 &&
    adminConnectionData.connections.some((item) => item.user_id === aliceId && item.server_name === externalServerName && item.mode === 'api_key') &&
    !adminConnectionBody.includes('smoke-user-key') && !adminConnectionBody.includes('secret'));
  const removeKey = await fetch(`${AUTH}/me/servers/${externalServerName}/credential`, { method: 'DELETE', headers: { cookie: personalCookie } });
  check('user removes personal credential', removeKey.status === 200 && (await externalInitRequest()).status === 409);

  const missingOAuthConnection = await fetch(`${GW}/mcp/${oauthServerName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }),
  });
  check('OAuth upstream requires personal authorization', missingOAuthConnection.status === 409);

  const oauthStart = await fetch(`${AUTH}/me/servers/${oauthServerName}/oauth`, { method: 'POST', headers: { cookie: personalCookie } });
  const oauthStartBody = await oauthStart.json() as { authorization_url?: string };
  check('user starts upstream OAuth with PKCE', oauthStart.status === 200 && !!oauthStartBody.authorization_url && new URL(oauthStartBody.authorization_url!).searchParams.get('code_challenge_method') === 'S256');
  const upstreamAuthorizePage = await fetch(oauthStartBody.authorization_url!, { headers: { cookie: personalCookie } }).then((res) => res.text());
  const upstreamFields = [...upstreamAuthorizePage.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]] as [string, string]);
  const upstreamApprove = await fetch(`${AUTH}/authorize/submit`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: personalCookie },
    body: new URLSearchParams(upstreamFields), redirect: 'manual',
  });
  const callbackWithIssuer = new URL(upstreamApprove.headers.get('location') ?? '');
  callbackWithIssuer.searchParams.set('iss', AUTH);
  const oauthCallback = await fetch(callbackWithIssuer, { headers: { cookie: personalCookie }, redirect: 'manual' });
  check('OAuth callback saves user credential', upstreamApprove.status === 302 && oauthCallback.status === 302 && (oauthCallback.headers.get('location') ?? '').includes('result=connected'));
  const oauthInit = await fetch(`${GW}/mcp/${oauthServerName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-smoke', version: '0' } } }),
  });
  check('OAuth-connected user reaches upstream MCP', oauthInit.status === 200);
  const revokeOAuthConnection = await fetch(`${AUTH}/admin/connections/${aliceId}/${oauthServerName}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` },
  });
  const revokedOAuthAccess = await fetch(`${GW}/mcp/${oauthServerName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }),
  });
  check('admin revokes a user OAuth connection', revokeOAuthConnection.status === 200 && revokedOAuthAccess.status === 409);
  const aliceDemoDenied = await fetch(`${GW}/mcp/demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });
  check('same user is denied at unassigned demo entrance', aliceDemoDenied.status === 403);

  const wildcardGrant = await fetch(`${AUTH}/admin/users/${aliceId}/servers`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ servers: ['*'] }),
  });
  check('admin grants ordinary user wildcard Server access', wildcardGrant.status === 200);
  const wildcardView = await fetch(`${AUTH}/admin/users/${aliceId}/servers`, { headers: { authorization: `Bearer ${adminToken}` } });
  check('admin API shows wildcard grant', (await wildcardView.json() as { servers: string[] }).servers.join(',') === '*');
  const wildcardFlow = await pkceLogin(aliceName, 'alice-pass-1');
  const wildcardToken = (await exchangeCode(
    new URL(wildcardFlow.submit.headers.get('location') ?? '').searchParams.get('code') ?? '', wildcardFlow.verifier,
  )).access_token ?? '';
  const wildcardClaims = JSON.parse(Buffer.from(wildcardToken.split('.')[1], 'base64url').toString());
  check('ordinary user wildcard appears in JWT', wildcardClaims.role === 'user' && wildcardClaims.mcp_servers?.join(',') === '*');
  const wildcardDemo = await fetch(`${GW}/mcp/demo`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${wildcardToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wildcard', version: '0' } } }),
  });
  check('wildcard ordinary user reaches previously unassigned Server', wildcardDemo.status === 200);
  const futureServerName = `future-${randomBytes(3).toString('hex')}`;
  const futureCreate = await fetch(`${AUTH}/admin/servers`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: futureServerName, display_name: 'Future wildcard fixture',
      instances: [{ url: `${REPORTS_UPSTREAM_URL}/mcp` }] }),
  });
  const futureAccess = await fetch(`${GW}/mcp/${futureServerName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${wildcardToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'future-wildcard', version: '0' } } }),
  });
  check('wildcard also permits newly registered Servers', futureCreate.status === 201 && futureAccess.status === 200);
  await fetch(`${AUTH}/admin/servers/${futureServerName}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });
  const wildcardConnections = await fetch(`${AUTH}/me/servers`, { headers: { cookie: personalCookie } });
  const wildcardServerNames = (await wildcardConnections.json() as { servers: Array<{ name: string }> }).servers.map((server) => server.name);
  check('wildcard user sees all Server connections', wildcardServerNames.includes('demo') && wildcardServerNames.includes('knowledge'));
  const wildcardRevoked = await fetch(`${AUTH}/admin/users/${aliceId}/servers`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ servers: ['reports', externalServerName, oauthServerName] }),
  });
  const revokedWildcardDemo = await fetch(`${GW}/mcp/demo`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${wildcardToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
  });
  check('revoking wildcard blocks an existing token immediately', wildcardRevoked.status === 200 && revokedWildcardDemo.status === 403);

  const externalDelete = await fetch(`${AUTH}/admin/servers/${externalServerName}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check('admin removes external MCP server', externalDelete.status === 200);
  await fetch(`${AUTH}/admin/servers/${oauthServerName}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });

  await fetch(`${AUTH}/admin/users/${aliceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ disabled: true }),
  });
  const disabledLogin = await pkceLogin(aliceName, 'alice-pass-1');
  check('disabled user rejected (401)', disabledLogin.submit.status === 401);
  const disabledOldToken = await fetch(`${GW}/mcp/reports`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceGrantedToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
  });
  check('disabled user existing access token is rejected', disabledOldToken.status === 403);
  const revokedSession = await fetch(`${AUTH}/me/session`, { headers: { cookie: personalCookie } });
  check('disabled user browser session is revoked', revokedSession.status === 401);

  const forbidden = await fetch(`${AUTH}/admin/users`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  check('non-admin blocked from admin API (403)', forbidden.status === 403);
  const forbiddenAudit = await fetch(`${AUTH}/admin/audit-events`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  check('non-admin blocked from audit API (403)', forbiddenAudit.status === 403);


  console.log(`\n${process.exitCode ? 'SMOKE TEST FAILED' : 'ALL SMOKE TESTS PASSED'}`);
}

main().catch((err) => {
  console.error('smoke test crashed:', err.message, (err as any).cause?.code ?? '');
  process.exit(1);
});
