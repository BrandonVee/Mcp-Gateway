/**
 * End-to-end smoke test against a running stack (docker compose up):
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
  const prMeta = await fetch(`${GW}/.well-known/oauth-protected-resource`).then((r) => r.json());
  check('protected-resource metadata', prMeta.authorization_servers?.[0] === AUTH, `auth server: ${prMeta.authorization_servers?.[0]}`);

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
  check('authorize form rendered', loginPage.includes('Authorize') && hidden.some(([k]) => k === 'code_challenge'));

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
  check('JWT claims', payload.iss === AUTH && payload.sub === 'demo-user' && payload.aud === 'mcp-gateway', `sub=${payload.sub} aud=${payload.aud}`);

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

  const aliceName = `alice-${randomBytes(3).toString('hex')}`; // unique per run (parallel-safe)
  const createRes = await fetch(`${AUTH}/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: aliceName, password: 'alice-pass-1', role: 'user' }),
  });
  check('admin creates user via API', createRes.status === 201 || createRes.status === 409, `status ${createRes.status}`);
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
  check('alice connects through gateway', aliceInit.status === 200);

  const allUsers = (await (await fetch(`${AUTH}/admin/users`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { users: { id: number; username: string }[] };
  const aliceId = allUsers.users.find((u) => u.username === aliceName)!.id;
  await fetch(`${AUTH}/admin/users/${aliceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ disabled: true }),
  });
  const disabledLogin = await pkceLogin(aliceName, 'alice-pass-1');
  check('disabled user rejected (401)', disabledLogin.submit.status === 401);

  const forbidden = await fetch(`${AUTH}/admin/users`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  check('non-admin blocked from admin API (403)', forbidden.status === 403);


  console.log(`\n${process.exitCode ? 'SMOKE TEST FAILED' : 'ALL SMOKE TESTS PASSED'}`);
}

main().catch((err) => {
  console.error('smoke test crashed:', err.message, (err as any).cause?.code ?? '');
  process.exit(1);
});
