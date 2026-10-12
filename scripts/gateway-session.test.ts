import assert from 'node:assert/strict';
import { get, createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { env, serverConfigs } from '../packages/gateway/src/config.js';
import { tokenAuthVersion } from '../packages/gateway/src/auth.js';
import { bindSession, pickInstance, redis, removeSession, touchSession } from '../packages/gateway/src/lb.js';
import { registerMcpRoutes } from '../packages/gateway/src/routes/mcp.js';

const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');
redis.disconnect();

/** Isolated Redis command double: no business keys or external Redis are used. */
class SessionRedis {
  now = 1000;
  touches = 0;
  entries = new Map<string, { value: string; expires: number }>();
  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now) return entry.value;
    this.entries.delete(key);
    return null;
  }
  async eval(
    _script: string,
    _count: number,
    binding: string,
    owner: string,
    action: string,
    user: string,
    seconds: number,
    url: string,
  ): Promise<number> {
    const currentOwner = await this.get(owner);
    if (action === 'bind') {
      if (currentOwner !== null && currentOwner !== user) return 0;
      this.entries.set(binding, { value: url, expires: this.now + seconds * 1000 });
      this.entries.set(owner, { value: user, expires: this.now + seconds * 1000 });
      return 1;
    }
    if (action === 'touch') this.touches++;
    if (currentOwner !== user || (await this.get(binding)) === null) return 0;
    if (action === 'remove') {
      this.entries.delete(binding);
      this.entries.delete(owner);
    } else {
      this.entries.get(binding)!.expires = this.now + seconds * 1000;
      this.entries.get(owner)!.expires = this.now + seconds * 1000;
    }
    return 1;
  }
}

async function fixture(t: TestContext) {
  const store = new SessionRedis();
  t.mock.method(redis, 'get', store.get.bind(store));
  t.mock.method(redis, 'eval', store.eval.bind(store));
  const previousTtl = env.sessionTtlSeconds;
  const previousBrokerToken = env.credentialBrokerToken;
  env.sessionTtlSeconds = 3;
  env.credentialBrokerToken = 'isolated-test-broker-token';
  let authVersion: unknown;
  const internalRequests: URL[] = [];
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/internal/mcp-access' || url.pathname === '/internal/connector-credential') {
      internalRequests.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.pathname === '/internal/mcp-access'
              ? {}
              : { header: 'authorization', value: 'Bearer isolated-upstream-token' },
          ),
          { status: 200 },
        ),
      );
    }
    return actualFetch(input, init);
  });
  const name = 'session-test';
  const id = 'owned-session';
  let upstreamRequests = 0;
  let upstreamAuthorization: string | undefined;
  let status = 200;
  const streams = new Set<ServerResponse>();
  const upstream = createServer(async (req, res) => {
    upstreamRequests++;
    upstreamAuthorization = req.headers.authorization;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res);
      res.once('close', () => streams.delete(res));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : { id: 0 };
    // Session assignment is required only on initialization; subsequent RPC
    // responses intentionally omit the header, as permitted by the protocol.
    if (rpc.method === 'initialize' || status === 404 || req.method === 'DELETE') res.setHeader('mcp-session-id', id);
    const code = rpc.method === 'initialize' ? 200 : status;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [] } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  serverConfigs.set(name, { name, authMode: 'none', instances: [url] });
  const app = Fastify();
  let resolveStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClosed = resolve;
  });
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req: unknown, body: Buffer, done: Function) =>
    done(null, body),
  );
  app.addHook('onRequest', async (req: any, reply: any) => {
    req.mcpAuth = {
      uid: Number(req.headers['x-test-user'] || 1),
      sub: 'test',
      mcp_servers: [name],
      auth_version: authVersion,
    };
    if (req.method === 'GET') reply.raw.once('close', resolveStreamClosed);
  });
  registerMcpRoutes(app);
  const binding = `gw:bind:${name}:${id}`;
  const owner = `gw:owner:${name}:${id}`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': id,
  };
  const rpc = (method = 'tools/list', user = 1) => {
    const requestHeaders: Record<string, string> = { ...headers, 'x-test-user': String(user) };
    if (method === 'initialize') delete requestHeaders['mcp-session-id'];
    return app.inject({
      method: 'POST',
      url: `/mcp/${name}`,
      headers: requestHeaders,
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    });
  };
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    serverConfigs.delete(name);
    env.sessionTtlSeconds = previousTtl;
    env.credentialBrokerToken = previousBrokerToken;
  });
  return {
    app,
    store,
    name,
    id,
    binding,
    owner,
    url,
    headers,
    rpc,
    streamClosed,
    internalRequests,
    authVersion: (version: unknown) => {
      authVersion = version;
    },
    requests: () => upstreamRequests,
    authorization: () => upstreamAuthorization,
    status: (code: number) => {
      status = code;
    },
  };
}

test('Gateway preserves owned sessions without an echoed response header', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc('initialize')).statusCode, 200);
  const originalExpiry = f.store.entries.get(f.owner)!.expires;
  f.store.now += 2500;
  const active = await f.rpc();
  assert.equal(active.statusCode, 200);
  assert.equal(active.headers['mcp-session-id'], undefined);
  assert.ok(f.store.entries.get(f.owner)!.expires > originalExpiry);
  f.store.now += 1000;
  assert.equal((await f.rpc()).statusCode, 200, 'a recently active session survives its original expiry');
  assert.equal(await f.store.get(f.binding), f.url, 'renewal preserves the original instance');

  const expiry = f.store.entries.get(f.owner)!.expires;
  const requests = f.requests();
  assert.equal((await f.rpc('tools/list', 2)).statusCode, 404);
  assert.equal(f.requests(), requests, 'another user cannot reach the upstream session');
  assert.equal(f.store.entries.get(f.owner)!.expires, expiry, 'another user cannot extend its lifetime');
  assert.equal(await touchSession(f.name, f.id, '2'), false);
  assert.equal(await removeSession(f.name, f.id, '2'), false);
  await assert.rejects(bindSession(f.name, f.id, 'http://other.test/mcp', '2'), /owner mismatch/);
  assert.equal(await f.store.get(f.binding), f.url);

  f.store.entries.delete(f.binding);
  const target = await pickInstance(serverConfigs.get(f.name)!, f.id);
  assert.equal(target.sticky, false, 'a missing binding is not legacy instance index zero');
  assert.equal((await f.rpc()).statusCode, 404, 'ownership alone cannot restore a missing binding');
});

test('Gateway sends the verified token revision to both internal authorization checks', async (t) => {
  const f = await fixture(t);
  f.authVersion(7);
  for (const mode of ['none', 'api_key', 'system_api_key', 'oauth'] as const) {
    serverConfigs.get(f.name)!.authMode = mode;
    const response = await f.app.inject({
      method: 'POST',
      url: `/mcp/${f.name}?auth_version=99&user_id=2`,
      headers: { 'content-type': 'application/json', accept: f.headers.accept, 'x-mcp-auth-version': '99' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(response.statusCode, 200);
    const internal = f.internalRequests.at(-1)!;
    assert.equal(internal.pathname, mode === 'none' ? '/internal/mcp-access' : '/internal/connector-credential');
    assert.equal(internal.searchParams.get('user_id'), '1');
    assert.equal(
      internal.searchParams.get('auth_version'),
      '7',
      'client headers and query cannot override the token revision',
    );
  }
  f.authVersion(undefined);
  assert.equal((await f.rpc('initialize')).statusCode, 200);
  assert.equal(f.internalRequests.at(-1)!.searchParams.get('auth_version'), '0', 'legacy tokens use revision zero');
  const requests = f.internalRequests.length;
  const upstream = f.requests();
  for (const version of [null, '7', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.authVersion(version);
    const response = await f.rpc('initialize');
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'invalid_token');
  }
  assert.equal(f.internalRequests.length, requests, 'invalid claims do not reach internal APIs');
  assert.equal(f.requests(), upstream, 'invalid claims do not reach MCP servers');
});

test('Gateway accepts only nonnegative safe integer JWT credential revisions', () => {
  assert.equal(tokenAuthVersion({}), 0);
  for (const version of [0, 1, Number.MAX_SAFE_INTEGER])
    assert.equal(tokenAuthVersion({ auth_version: version }), version);
  for (const version of [null, '', '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, false, {}]) {
    assert.equal(tokenAuthVersion({ auth_version: version }), null);
  }
});

test('Gateway removes upstream-terminated sessions and preserves temporary failures', async (t) => {
  const f = await fixture(t);
  await f.rpc('initialize');
  f.status(503);
  assert.equal((await f.rpc()).statusCode, 503);
  assert.equal(await f.store.get(f.binding), f.url, 'a temporary failure does not terminate the session');
  f.status(404);
  assert.equal((await f.rpc()).statusCode, 404);
  assert.equal(await f.store.get(f.binding), null);
  assert.equal(await f.store.get(f.owner), null, 'an echoed header on a 404 cannot resurrect the session');
  const requests = f.requests();
  assert.equal((await f.rpc()).statusCode, 404);
  assert.equal(f.requests(), requests);

  await f.rpc('initialize');
  f.status(405);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/mcp/${f.name}`, headers: f.headers })).statusCode, 405);
  assert.equal(await f.store.get(f.binding), f.url, 'an unsupported DELETE keeps the session');
  f.status(200);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/mcp/${f.name}`, headers: f.headers })).statusCode, 200);
  assert.equal(await f.store.get(f.binding), null);
  assert.equal(await f.store.get(f.owner), null, 'successful DELETE retires both session keys');
});

test('Gateway renews a long SSE session only while its response remains active', async (t) => {
  const f = await fixture(t);
  await f.rpc('initialize');
  const originalExpiry = f.store.entries.get(f.owner)!.expires;
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const address = f.app.server.address();
  assert.ok(address && typeof address !== 'string');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const request = get(`http://127.0.0.1:${address.port}/mcp/${f.name}`, { headers: f.headers });
  request.on('error', () => undefined);
  const response = await new Promise<import('node:http').IncomingMessage>((resolve) =>
    request.once('response', resolve),
  );
  response.on('error', () => undefined);
  response.resume();
  assert.equal(response.statusCode, 200);
  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  for (let i = 0; i < 7; i++) {
    f.store.now += 1000;
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.ok(f.store.now > originalExpiry);
  assert.equal(await f.store.get(f.owner), '1', 'an open stream retains ownership beyond the initial TTL');
  assert.equal((await f.rpc()).statusCode, 200);
  response.destroy();
  request.destroy();
  await new Promise<void>((resolve) => response.once('close', resolve));
  await f.streamClosed;
  await flush();
  await flush();
  const touches = f.store.touches;
  f.store.now += 5000;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(f.store.touches, touches, 'closing the downstream stream stops renewal');
  assert.equal(await f.store.get(f.owner), null, 'an inactive session can expire normally');
  t.mock.timers.reset();
});

test('system API keys are injected upstream and rejected keys require administrator repair', async (t) => {
  const f = await fixture(t);
  serverConfigs.get(f.name)!.authMode = 'system_api_key';
  assert.equal((await f.rpc('initialize')).statusCode, 200);
  assert.equal(f.authorization(), 'Bearer isolated-upstream-token');
  for (const status of [401, 403]) {
    f.status(status);
    const response = await f.rpc();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'system_credential_rejected', server: f.name });
  }
});
