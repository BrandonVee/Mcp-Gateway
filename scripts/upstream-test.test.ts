import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { testUpstreamMcp, upstreamTestFailure } from '../packages/gateway/src/upstream-test.js';
import { registerUpstreamTestRoute } from '../packages/gateway/src/routes/upstream-test.js';
import { requestUpstreamTest } from '../packages/auth-server/src/modules/upstreams/connection-test.js';
import { validateUpstreamEndpoint } from '../packages/shared/src/index.js';
import { loopbackUpstreamEndpoint } from '../packages/admin-web/src/features/servers/UpstreamConnectionTest';

const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');

async function httpFixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function mcpFixture(
  t: TestContext,
  options: { sse?: boolean; stateful?: boolean; toolError?: boolean; tools?: boolean } = {},
) {
  const methods: string[] = [];
  let terminated = false;
  const endpoint = await httpFixture(t, (req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, undefined);
      if (req.method === 'DELETE') {
        assert.equal(req.headers['mcp-session-id'], 'diagnostic-session');
        terminated = true;
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const rpc = JSON.parse(raw);
      methods.push(rpc.method);
      if (rpc.method !== 'initialize' && options.stateful)
        assert.equal(req.headers['mcp-session-id'], 'diagnostic-session');
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (options.stateful && rpc.method === 'initialize') res.setHeader('mcp-session-id', 'diagnostic-session');
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: options.tools === false ? {} : { tools: {} },
              serverInfo: { name: 'fixture-mcp', version: '1.2.3' },
            }
          : { tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] };
      const message = JSON.stringify(
        options.toolError && rpc.method === 'tools/list'
          ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'private-upstream-detail' } }
          : { jsonrpc: '2.0', id: rpc.id, result },
      );
      if (options.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Split an event across TCP writes.
        res.write(': keepalive\n\nevent: message\nda');
        res.end(`ta: ${message}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(message);
      }
    })().catch((error) => {
      res.destroy(error);
    });
  });
  return {
    endpoint,
    methods,
    get terminated() {
      return terminated;
    },
  };
}

test('MCP tests initialize JSON and SSE endpoints, discover tools and clean up stateful sessions', async (t) => {
  for (const sse of [false, true]) {
    for (const stateful of [false, true]) {
      const fixture = await mcpFixture(t, { sse, stateful });
      const result = await testUpstreamMcp(fixture.endpoint);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.server, { name: 'fixture-mcp', version: '1.2.3' });
      assert.equal(result.tools_count, 1);
      assert.deepEqual(fixture.methods, ['initialize', 'notifications/initialized', 'tools/list']);
      assert.equal(fixture.terminated, stateful);
      assert.equal(result.http_status, 200);
      assert.ok(result.protocol_version);
    }
  }
});

test('resource-only MCP servers pass initialization without an unsupported tools/list request', async (t) => {
  const fixture = await mcpFixture(t, { tools: false });
  const result = await testUpstreamMcp(fixture.endpoint);
  assert.equal(result.ok, true);
  assert.equal(result.tools_count, null);
  assert.deepEqual(fixture.methods, ['initialize', 'notifications/initialized']);
});

test('tool discovery failure is distinct from initialization and never exposes upstream error text', async (t) => {
  const fixture = await mcpFixture(t, { stateful: true, toolError: true });
  const result = await testUpstreamMcp(fixture.endpoint);
  assert.equal(result.reason, 'tools_failed');
  assert.equal(result.stage, 'tools');
  assert.equal(fixture.terminated, true);
  assert.doesNotMatch(JSON.stringify(result), /private-upstream-detail/);
});

test('HTTP errors, redirects and non-MCP endpoints have actionable results', async (t) => {
  for (const [status, reason] of [
    [401, 'auth_required'],
    [403, 'access_denied'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [503, 'http'],
    [307, 'redirect'],
  ] as const) {
    let redirects = 0;
    const target = await httpFixture(t, (_req, res) => {
      redirects++;
      res.writeHead(200).end('{}');
    });
    const endpoint = await httpFixture(t, (_req, res) => {
      res.writeHead(status, { location: target }).end('private-response-body');
    });
    const result = await testUpstreamMcp(endpoint);
    assert.equal(result.reason, reason);
    assert.equal(result.http_status, status);
    assert.equal(redirects, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-response-body/);
  }
  const endpoint = await httpFixture(t, (_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
  );
  assert.equal((await testUpstreamMcp(endpoint, 300)).reason, 'invalid_mcp');
});

test('tests stop on connection refusal, stalled responses and oversized bodies', async (t) => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const address = closed.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.equal((await testUpstreamMcp(`http://127.0.0.1:${address.port}/mcp`)).reason, 'connection_refused');
  const stalled = await httpFixture(t, () => {});
  const started = performance.now();
  assert.equal((await testUpstreamMcp(stalled, 100)).reason, 'timeout');
  assert.ok(performance.now() - started < 2000);
  const huge = await httpFixture(t, (_req, res) =>
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })),
  );
  assert.equal((await testUpstreamMcp(huge, 500)).reason, 'response_too_large');
});

test('DNS and certificate errors are classified without disclosing exception messages', () => {
  assert.equal(upstreamTestFailure(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), 'dns');
  assert.equal(upstreamTestFailure({ cause: { code: 'EAI_AGAIN' } }), 'dns');
  assert.equal(upstreamTestFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }), 'tls');
  assert.equal(upstreamTestFailure({ code: 'UND_ERR_CONNECT_TIMEOUT' }), 'timeout');
  assert.equal(upstreamTestFailure({ cause: { code: 'EHOSTUNREACH' } }), 'network');
  for (const url of [
    'http://127.0.0.1:8766/mcp/fx',
    'http://127.2.3.4/mcp',
    'http://[::1]/mcp',
    'http://localhost/mcp',
    'http://2130706433/mcp',
  ])
    assert.equal(loopbackUpstreamEndpoint(url), true);
  assert.equal(loopbackUpstreamEndpoint('http://fx-app-1:8765/mcp/fx'), false);
});

test('gateway probe route requires the internal token, refreshes policy and never probes blocked hosts', async (t) => {
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req: unknown, body: Buffer, done: Function) =>
    done(null, body),
  );
  t.after(() => app.close());
  let refreshes = 0;
  let probes = 0;
  const fixture = await mcpFixture(t);
  registerUpstreamTestRoute(app, {
    token: 'private-test-token',
    refreshPolicy: async () => {
      refreshes++;
    },
    validate: (url) =>
      validateUpstreamEndpoint(url, {
        MCP_UPSTREAM_ALLOWLIST_ENABLED: 'true',
        MCP_UPSTREAM_ALLOWED_HOSTS: '127.0.0.1',
      }),
    probe: async (url) => {
      probes++;
      return testUpstreamMcp(url);
    },
  });
  for (const authorization of [undefined, 'Bearer incorrect', 'private-test-token']) {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/upstream-test',
      headers: authorization ? { authorization } : {},
      payload: { url: fixture.endpoint },
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(refreshes, 0);
  const headers = { authorization: 'Bearer private-test-token' };
  const blocked = await app.inject({
    method: 'POST',
    url: '/internal/upstream-test',
    headers,
    payload: { url: 'http://untrusted.invalid/mcp' },
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error, 'upstream_host_not_allowed');
  assert.equal(probes, 0);
  const passed = await app.inject({
    method: 'POST',
    url: '/internal/upstream-test',
    headers,
    payload: { url: fixture.endpoint },
  });
  assert.equal(passed.json().ok, true);
  assert.equal(probes, 1);
  assert.equal(refreshes, 2);
});

test('control plane forwards only the endpoint to the configured gateway and rejects malformed responses', async (t) => {
  const fixture = await mcpFixture(t);
  const expected = await testUpstreamMcp(fixture.endpoint);
  let valid = true;
  const endpoint = await httpFixture(t, (req, res) => {
    void (async () => {
      assert.equal(req.url, '/internal/upstream-test');
      assert.equal(req.headers.authorization, 'Bearer internal-probe-token');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.deepEqual(JSON.parse(raw), { url: fixture.endpoint });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(valid ? expected : { ok: true }));
    })().catch((error) => res.destroy(error));
  });
  const options = { gatewayUrl: endpoint, token: 'internal-probe-token' };
  assert.deepEqual(await requestUpstreamTest(fixture.endpoint, options), expected);
  valid = false;
  const unavailable = await requestUpstreamTest(fixture.endpoint, options);
  assert.ok('reason' in unavailable);
  assert.equal(unavailable.reason, 'gateway_unavailable');
});

test('probe capacity covers policy refresh and is released after failed requests', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const releases: (() => void)[] = [];
  let failRefresh = false;
  registerUpstreamTestRoute(app, {
    token: 'capacity-token',
    refreshPolicy: () =>
      new Promise<void>((resolve, reject) =>
        releases.push(() => (failRefresh ? reject(new Error('refresh failed')) : resolve())),
      ),
    validate: () => ({ error: 'invalid_upstream_endpoint' }),
  });
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/internal/upstream-test',
      headers: { authorization: 'Bearer capacity-token' },
      payload: { url: 'http://fixture.invalid/mcp' },
    });
  const pending = Array.from({ length: 4 }, request);
  await new Promise<void>((resolve) => {
    const poll = () => (releases.length === 4 ? resolve() : setTimeout(poll, 1));
    poll();
  });
  assert.equal((await request()).json().reason, 'busy');
  failRefresh = true;
  releases.splice(0).forEach((release) => release());
  for (const response of await Promise.all(pending)) assert.equal(response.json().reason, 'gateway_unavailable');
  failRefresh = false;
  const next = request();
  await new Promise<void>((resolve) => {
    const poll = () => (releases.length ? resolve() : setTimeout(poll, 1));
    poll();
  });
  releases.shift()!();
  assert.equal((await next).statusCode, 400);
});

test('control plane preserves updated gateway policy errors without exposing extra fields', async (t) => {
  const endpoint = await httpFixture(t, (_req, res) =>
    res
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'upstream_host_not_allowed', host: 'private-data', details: 'secret' })),
  );
  const result = await requestUpstreamTest('http://fx-app-1:8765/mcp/fx', {
    gatewayUrl: endpoint,
    token: 'internal-token',
  });
  assert.deepEqual(result, { error: 'upstream_host_not_allowed', host: 'fx-app-1' });
});
