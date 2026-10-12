/** End-to-end grouped endpoints with a disposable schema and local upstreams. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createIsolatedAuthSchema } from './isolated-auth-schema.js';

async function main() {
  const isolated = await createIsolatedAuthSchema();
  process.env.DATABASE_URL = isolated.databaseUrl;
  process.env.NODE_ENV = 'development';
  process.env.SYSTEM_CONFIG_MODE = 'database';
  process.env.CREDENTIAL_ENCRYPT_KEY = 'a'.repeat(64);
  process.env.CREDENTIAL_BROKER_TOKEN = 'group-test-broker';
  const { db, pool, createLoginSession } = await import('../packages/auth-server/src/db.js');
  const { users, upstreamCredentials } = await import('../packages/auth-server/src/schema.js');
  const { createAdminRouter } = await import('../packages/auth-server/src/admin.js');
  const { createConnectionsRouter } = await import('../packages/auth-server/src/connections.js');
  const { createRegistryRouter } = await import('../packages/auth-server/src/registry.js');
  const { loadSigningKeys } = await import('../packages/auth-server/src/keys.js');
  const { saveSystemSettings } = await import('../packages/auth-server/src/system-settings.js');
  const { resolveUpstreamCredential } = await import('../packages/auth-server/src/upstream-connections.js');
  const { env, serverConfigs } = await import('../packages/gateway/src/config.js');
  const { redis } = await import('../packages/gateway/src/lb.js');
  const { registerMcpRoutes } = await import('../packages/gateway/src/routes/mcp.js');
  const { upstreamNamespace } = await import('../packages/gateway/src/aggregate.js');
  const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');
  const group = `group-${randomUUID()}`;
  const upstreamCalls: Array<{ path: string; authorization?: string; key?: string; session?: string; method: string }> =
    [];
  let exchanges = 0,
    refreshes = 0;
  let delayCode: string | undefined,
    exchangeStarted: (() => void) | undefined,
    finishExchange: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') refreshes++;
      else exchanges++;
      if (params.get('code') === delayCode) {
        exchangeStarted?.();
        await new Promise<void>((resolve) => {
          finishExchange = resolve;
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          access_token: `oauth-access-${exchanges}`,
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: params.get('grant_type') === 'refresh_token' ? 3600 : 1,
        }),
      );
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    const rpc = JSON.parse(body);
    upstreamCalls.push({
      path: req.url!,
      authorization: req.headers.authorization,
      key: req.headers['x-api-key'] as string,
      session: req.headers['mcp-session-id'] as string,
      method: rpc.method,
    });
    const expected =
      req.url === '/a' ? 'key-a' : req.url === '/b' ? 'key-b' : req.url === '/personal' ? 'personal-key' : null;
    if (expected && req.headers['x-api-key'] !== expected) {
      res.writeHead(401).end('{}');
      return;
    }
    if (req.url?.startsWith('/oauth') && !req.headers.authorization?.startsWith('Bearer oauth-access-')) {
      res.writeHead(401).end('{}');
      return;
    }
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'initialize') res.setHeader('mcp-session-id', `${req.url!.slice(1)}-${randomUUID()}`);
    const result =
      rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: req.url, version: '1' } }
        : rpc.method === 'tools/list'
          ? { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: req.url }] };
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  const gateways: any[] = [];
  const originalFetch = globalThis.fetch;
  try {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    await saveSystemSettings({
      public_url: 'https://group-test.example',
      upstream_allowlist_enabled: false,
      upstream_hosts: [],
    });
    const [admin, alice, bob] = await db
      .insert(users)
      .values(
        ['admin', 'alice', 'bob'].map((name, i) => ({
          username: name,
          passwordHash: 'unused',
          role: i === 0 ? ('admin' as const) : ('user' as const),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      )
      .returning();
    const cookies = await Promise.all(
      [admin, alice, bob].map(async (u) => `auth_session=${await createLoginSession(u.id, 0)}`),
    );
    const app = createAdminRouter({ keys: await loadSigningKeys(), issuer: 'http://localhost:9001' });
    app.route('/', createConnectionsRouter());
    app.route('/', createRegistryRouter());
    async function api(path: string, method = 'GET', body?: unknown, who = 0) {
      const response = await app.request(path, {
        method,
        headers: { cookie: cookies[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        data: response.status === 302 ? response.headers.get('location') : ((await response.json()) as any),
      };
    }
    assert.equal(
      (
        await api('/admin/servers', 'POST', {
          name: group,
          instances: [],
          auth_mode: 'none',
          routing_mode: 'aggregate',
        })
      ).status,
      201,
    );
    assert.equal((await api(`/admin/users/${alice.id}/servers`, 'PUT', { servers: [group] })).status, 200);
    assert.equal(
      (
        await api(`/admin/servers/${group}`, 'PATCH', {
          auth_mode: 'system_api_key',
          system_api_key: 'invalid-group-key',
        })
      ).status,
      400,
      'aggregate groups cannot own upstream credentials',
    );
    const add = (id: string, path: string, auth: object) =>
      api(`/admin/servers/${group}/instances`, 'POST', { id, display_name: id, url: base + path, ...auth });
    const a = `a-${group}`,
      b = `b-${group}`,
      personal = `personal-${group}`,
      oauth = `oauth-${group}`;
    const keyAuth = { auth_mode: 'system_api_key', api_key_header: 'x-api-key', api_key_prefix: '' };
    assert.equal((await add(a, '/a', { ...keyAuth, system_api_key: 'key-a' })).status, 201);
    assert.equal((await add(b, '/b', { ...keyAuth, system_api_key: 'key-b' })).status, 201);
    assert.equal(
      (await add(personal, '/personal', { auth_mode: 'api_key', api_key_header: 'x-api-key', api_key_prefix: '' }))
        .status,
      201,
    );
    const oauthAuth = {
      auth_mode: 'system_oauth',
      oauth_authorize_url: 'https://provider.example/authorize',
      oauth_token_url: base + '/token',
      oauth_client_id: 'group-client',
      oauth_client_auth_method: 'none',
    };
    assert.equal((await add(oauth, '/oauth', oauthAuth)).status, 201);
    const dto = (await api('/admin/servers')).data.servers.find((s: any) => s.name === group);
    assert.equal(dto.instances.length, 4);
    assert.ok(!JSON.stringify(dto).includes('key-a'));
    assert.ok(!JSON.stringify(dto).includes('key-b'));
    assert.equal((await api('/me/upstreams', 'GET', undefined, 1)).data.servers.length, 4);
    assert.equal((await api('/me/upstreams', 'GET', undefined, 2)).data.servers.length, 0);
    assert.equal((await api(`/me/upstreams/${a}/credential`, 'PUT', { api_key: 'override' }, 1)).status, 409);
    assert.equal((await api(`/me/upstreams/${oauth}/oauth`, 'POST', undefined, 1)).status, 403);
    const started = await api(`/me/upstreams/${oauth}/oauth`, 'POST');
    assert.equal(started.status, 200);
    const state = new URL(started.data.authorization_url).searchParams.get('state')!;
    const callback = await api(`/oauth/upstream-callback/${oauth}?state=${state}&code=system-code`);
    assert.equal(callback.status, 302);
    assert.match(callback.data, /result=connected/);
    const identity = { id: alice.id, authVersion: 0, role: 'user' as const };
    const resolved = await Promise.all([
      resolveUpstreamCredential(oauth, identity, group),
      resolveUpstreamCredential(oauth, identity, group),
    ]);
    assert.ok(resolved.every((r) => 'credential' in r && r.credential?.value.startsWith('Bearer oauth-access-')));
    assert.equal(refreshes, 1, 'shared OAuth refresh is serialized across users/requests');
    assert.equal((await api(`/me/upstreams/${oauth}/credential`, 'DELETE', undefined, 1)).status, 403);
    const replay = await api(`/oauth/upstream-callback/${oauth}?state=${state}&code=system-code`);
    assert.match(replay.data, /invalid_state/);
    assert.equal(exchanges, 1);
    assert.ok(
      (await db.select().from(upstreamCredentials))
        .filter((r) => r.owner === 'system')
        .every((r) => r.userId === null && !r.secret.includes('oauth-access')),
    );
    assert.equal(
      (await api(`/me/upstreams/${personal}/credential`, 'PUT', { api_key: 'personal-key' }, 1)).status,
      200,
    );
    assert.ok(
      'missing' in (await resolveUpstreamCredential(personal, { id: admin.id, authVersion: 0, role: 'admin' }, group)),
    );
    assert.ok('denied' in (await resolveUpstreamCredential(a, identity, 'other-group')));
    assert.ok(
      'configChanged' in (await resolveUpstreamCredential(a, identity, group, 'https://stale-address.test/mcp')),
    );
    // Two Gateway processes share only Redis session data, not local in-memory transports.
    const cfg = {
      name: group,
      authMode: 'none' as const,
      instances: dto.instances.map((i: any) => i.url),
      upstreams: dto.instances.map((i: any) => ({ id: i.id, url: i.url, authMode: i.auth_mode })),
    };
    serverConfigs.set(group, cfg);
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.startsWith('/internal/')) return app.request(parsed.pathname + parsed.search, init);
      return originalFetch(url, init);
    };
    for (let i = 0; i < 2; i++) {
      const gw = Fastify();
      gw.addHook('onRequest', async (req: any) => {
        req.mcpAuth = { uid: Number(req.headers['x-test-user'] || alice.id), auth_version: 0, mcp_servers: [group] };
      });
      gw.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req: any, body: Buffer, done: Function) =>
        done(null, body),
      );
      registerMcpRoutes(gw);
      gateways.push(gw);
    }
    let sid = '';
    const rpc = (gw: any, method: string, params = {}, user = alice.id) =>
      gw.inject({
        method: 'POST',
        url: `/mcp/${group}`,
        headers: {
          'content-type': 'application/json',
          'x-test-user': String(user),
          ...(sid ? { 'mcp-session-id': sid } : {}),
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    const initialized = await rpc(gateways[0], 'initialize');
    assert.equal(initialized.statusCode, 200, initialized.body);
    sid = initialized.headers['mcp-session-id'];
    const listed = await rpc(gateways[1], 'tools/list');
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().result.tools.length, 4);
    for (const id of [a, b, personal, oauth]) {
      const called = await rpc(gateways[1], 'tools/call', { name: `${upstreamNamespace(id)}__search`, arguments: {} });
      assert.equal(called.statusCode, 200, called.body);
    }
    assert.ok(upstreamCalls.filter((c) => c.path === '/a').every((c) => c.key === 'key-a' && !c.authorization));
    assert.ok(upstreamCalls.filter((c) => c.path === '/b').every((c) => c.key === 'key-b' && !c.authorization));
    assert.ok(upstreamCalls.filter((c) => c.path === '/personal').every((c) => c.key === 'personal-key'));
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await gateways[0].listen({ port: 0, host: '127.0.0.1' });
    const sdk = new Client({ name: 'group-integration-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${group}`, gateways[0].listeningOrigin));
    await sdk.connect(transport);
    assert.equal((await sdk.listTools()).tools.length, 4);
    const sdkResult = await sdk.callTool({ name: `${upstreamNamespace(a)}__search`, arguments: {} });
    assert.deepEqual(sdkResult.content, [{ type: 'text', text: '/a' }]);
    await transport.terminateSession();
    await sdk.close();
    // A stale routing snapshot must not send a new key to the former URL.
    const callCount = upstreamCalls.length;
    await api(`/admin/servers/${group}/instances/${a}`, 'PATCH', {
      ...keyAuth,
      system_api_key: 'new-key-a',
      url: base + '/a-new',
    });
    assert.equal(
      (await rpc(gateways[0], 'tools/call', { name: `${upstreamNamespace(a)}__search`, arguments: {} })).statusCode,
      503,
    );
    assert.equal(upstreamCalls.length, callCount, 'credential URL binding blocks every stale upstream request');
    await api(`/admin/servers/${group}/instances/${a}`, 'PATCH', {
      ...keyAuth,
      system_api_key: 'key-a',
      url: base + '/a',
    });

    assert.equal(
      (await rpc(gateways[0], 'tools/list', {}, admin.id)).statusCode,
      404,
      'a shared group does not share user sessions',
    );
    assert.equal((await api(`/me/upstreams/${personal}/credential`, 'DELETE', undefined, 1)).status, 200);
    assert.equal((await rpc(gateways[0], 'tools/list')).json().result.tools.length, 3);
    const before = upstreamCalls.length;
    await api(`/admin/users/${alice.id}/servers`, 'PUT', { servers: [] });
    assert.equal((await rpc(gateways[0], 'tools/list')).statusCode, 403);
    assert.equal(upstreamCalls.length, before);
    // Disconnect while the provider request is in flight cannot resurrect a shared grant.
    const again = await api(`/me/upstreams/${oauth}/oauth`, 'POST');
    const newState = new URL(again.data.authorization_url).searchParams.get('state')!;
    delayCode = 'delayed';
    const startedExchange = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const pending = api(`/oauth/upstream-callback/${oauth}?state=${newState}&code=delayed`);
    await startedExchange;
    await api(`/me/upstreams/${oauth}/credential`, 'DELETE');
    finishExchange!();
    assert.match((await pending).data, /invalid_state/);
    assert.ok(
      'missing' in (await resolveUpstreamCredential(oauth, { id: admin.id, authVersion: 0, role: 'admin' }, group)),
    );
    // User OAuth remains per-user even inside a group with shared system OAuth.
    await api(`/admin/users/${alice.id}/servers`, 'PUT', { servers: [group] });
    assert.equal(
      (
        await api(`/admin/servers/${group}/instances/${personal}`, 'PATCH', {
          ...oauthAuth,
          auth_mode: 'oauth',
          url: base + '/oauth-personal',
        })
      ).status,
      200,
    );
    const userStart = await api(`/me/upstreams/${personal}/oauth`, 'POST', undefined, 1);
    assert.equal(userStart.status, 200);
    const userState = new URL(userStart.data.authorization_url).searchParams.get('state')!;
    const userCallback = await api(
      `/oauth/upstream-callback/${personal}?state=${userState}&code=alice-code`,
      'GET',
      undefined,
      1,
    );
    assert.match(userCallback.data, /result=connected/);
    assert.ok('credential' in (await resolveUpstreamCredential(personal, identity, group)));
    assert.ok(
      'missing' in (await resolveUpstreamCredential(personal, { id: admin.id, authVersion: 0, role: 'admin' }, group)),
    );
    assert.equal((await api(`/admin/servers/${group}/instances/${b}`, 'PATCH', { enabled: false })).status, 200);
    assert.ok('denied' in (await resolveUpstreamCredential(b, identity, group)));
    assert.ok(
      'credential' in (await resolveUpstreamCredential(a, identity, group)),
      'disabling one upstream leaves others usable',
    );
    await api(`/admin/upstream-connections/${alice.id}/${personal}`, 'DELETE');
    assert.ok('missing' in (await resolveUpstreamCredential(personal, identity, group)));
    const legacyName = `${group}-old`,
      legacyId = `old-${group}`;
    assert.equal(
      (
        await api('/admin/servers', 'POST', {
          name: legacyName,
          auth_mode: 'api_key',
          api_key_header: 'x-api-key',
          api_key_prefix: '',
          instances: [{ id: legacyId, url: base + '/personal' }],
        })
      ).status,
      201,
    );
    await api(`/admin/users/${alice.id}/servers`, 'PUT', { servers: [group, legacyName] });
    await api(`/me/servers/${legacyName}/credential`, 'PUT', { api_key: 'latest-legacy-key' }, 1);
    await api(`/admin/servers/${legacyName}`, 'PATCH', { routing_mode: 'aggregate' });
    const converted = await resolveUpstreamCredential(legacyId, identity, legacyName);
    assert.ok('credential' in converted);
    assert.equal(
      converted.credential?.value,
      'latest-legacy-key',
      'conversion copies the current legacy credentials, not a stale migration snapshot',
    );
    console.log(
      'PASS: independent keys, personal connections, admin-only shared OAuth, refresh serialization, replay and disconnect races, grouped RPC aggregation across Gateway replicas, namespace routing and live grant revocation',
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const gw of gateways) await gw.close();
    serverConfigs.delete(group);
    const keys = await redis.keys(`gw:aggregate:${group}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await pool.end();
    await isolated.cleanup();
  }
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
