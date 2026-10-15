import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { applySystemSettings, currentSystemSettings, type CallEvent, type McpServerConfig } from '@/shared/index.js';
import { env, serverConfigs } from '@/gateway/config.js';
import { redis } from '@/gateway/lb.js';
import { monitoringRedis, registerMonitoring } from '@/gateway/monitoring.js';
import { registerMcpRoutes } from '@/gateway/routes/mcp.js';

const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');
redis.disconnect();
monitoringRedis.disconnect();

/** A local command double; real Lua atomicity is exercised by smoke-gateway-reliability.ts. */
class MemorySessions {
  entries = new Map<string, string>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, value: string, ...options: unknown[]) {
    if (options.includes('NX') && this.entries.has(key)) return null;
    this.entries.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    return Number(this.entries.delete(key));
  }
  async expire(key: string) {
    return Number(this.entries.has(key));
  }
  async eval(script: string, count: number, ...args: (string | number)[]) {
    if (count === 2) {
      const [key, guard, expected, updated, _ttl, token] = args.map(String);
      if (this.entries.get(key) !== expected) return 0;
      if (guard !== key && this.entries.get(guard) !== token) return -1;
      this.entries.set(key, updated);
      return 1;
    }
    const [key, token] = args.map(String);
    if (this.entries.get(key) !== token) return 0;
    if (script.includes("'del'")) this.entries.delete(key);
    return 1;
  }
}

async function fixture(t: TestContext) {
  const store = new MemorySessions();
  for (const method of ['get', 'set', 'del', 'expire', 'eval'] as const)
    t.mock.method(redis, method, store[method].bind(store) as any);
  const events: CallEvent[] = [];
  const reports: any[] = [];
  (monitoringRedis as any).status = 'ready';
  t.mock.method(monitoringRedis, 'eval', async (...args: any[]) => {
    events.push(JSON.parse(args[4]));
    return 1;
  });
  const previous = currentSystemSettings(),
    token = env.credentialBrokerToken;
  applySystemSettings({ ...previous, monitoring_enabled: true, monitoring_logs_enabled: true });
  env.credentialBrokerToken = 'isolated-credential-broker';
  const name = 'aggregate-regression';
  const cfg: McpServerConfig = {
    name,
    authMode: 'none',
    instances: ['http://isolated-upstream.test/mcp'],
    upstreams: [{ id: 'upstream', url: 'http://isolated-upstream.test/mcp', authMode: 'api_key' }],
  };
  serverConfigs.set(name, cfg);
  let gate: (() => Promise<void>) | undefined;
  let rejected = false,
    version = 'a'.repeat(64),
    initializes = 0;
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/internal/mcp-access') return Response.json({});
    if (url.pathname === '/internal/upstream-credential')
      return Response.json({
        revision: 0,
        credential: { header: 'x-api-key', value: 'private-upstream-key' },
        credential_version: version,
        validation_status: 'saved',
      });
    if (url.pathname === '/internal/credential-validation') {
      reports.push(JSON.parse(init.body));
      return Response.json({ updated: true });
    }
    assert.equal(url.hostname, 'isolated-upstream.test');
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = JSON.parse(init.body);
    if (rejected) return new Response('{}', { status: 401 });
    if (rpc.method === 'initialize') {
      initializes++;
      return Response.json(
        {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
          },
        },
        { headers: { 'mcp-session-id': 'upstream-session' } },
      );
    }
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'tools/list')
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          tools: ['fast', 'slow', 'fail', 'rpc_error'].map((name) => ({ name, inputSchema: { type: 'object' } })),
        },
      });
    await gate?.();
    return Response.json({
      jsonrpc: '2.0',
      id: rpc.id,
      ...(rpc.params.name === 'rpc_error'
        ? { error: { code: -32602, message: 'invalid argument' } }
        : {
            result: {
              isError: rpc.params.name === 'fail',
              content: [{ type: 'text', text: 'result' }],
              api_key: 'never-store',
            },
          }),
    });
  });
  const app = Fastify();
  registerMonitoring(app);
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req: any, body: Buffer, done: any) =>
    done(null, body),
  );
  app.addHook('onRequest', async (req: any) => {
    req.mcpAuth = { uid: 1, sub: 'alice', auth_version: 0, mcp_servers: [name] };
  });
  registerMcpRoutes(app);
  let sid = '',
    id = 0;
  const rpc = (method: string, params?: any) =>
    app.inject({
      method: 'POST',
      url: `/mcp/${name}`,
      headers: { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) },
      payload: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
  const initialized = await rpc('initialize');
  assert.equal(initialized.statusCode, 200, initialized.body);
  sid = initialized.headers['mcp-session-id'] as string;
  assert.equal((await rpc('tools/list')).statusCode, 200);
  t.after(async () => {
    await app.close();
    serverConfigs.delete(name);
    applySystemSettings(previous);
    env.credentialBrokerToken = token;
    (monitoringRedis as any).status = 'close';
  });
  return {
    app,
    cfg,
    store,
    events,
    reports,
    rpc,
    key: `gw:aggregate:${name}:${sid}`,
    setGate: (value?: () => Promise<void>) => {
      gate = value;
    },
    reject: () => {
      rejected = true;
    },
    replaceKey: () => {
      version = 'b'.repeat(64);
    },
    initializes: () => initializes,
    remove: () => app.inject({ method: 'DELETE', url: `/mcp/${name}`, headers: { 'mcp-session-id': sid } }),
  };
}

test('parallel tools in the same session both reach upstream before either finishes', async (t) => {
  const f = await fixture(t);
  let entered = 0,
    release!: () => void,
    bothEntered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const both = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  f.setGate(async () => {
    if (++entered === 2) bothEntered();
    await waiting;
  });
  const requests = ['fast', 'slow'].map((name) => f.rpc('tools/call', { name }).then((r: any) => r));
  try {
    await Promise.race([
      both,
      new Promise((_, reject) => setTimeout(() => reject(new Error('tools serialized')), 1000)),
    ]);
  } finally {
    release();
  }
  const responses = await Promise.all(requests);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 200],
  );
});

test('aggregate monitoring records successful, tool-error and JSON-RPC-error results exactly once', async (t) => {
  const f = await fixture(t);
  for (const name of ['fast', 'fail', 'rpc_error']) assert.equal((await f.rpc('tools/call', { name })).statusCode, 200);
  const events = f.events.filter((event) => event.method === 'tools/call');
  assert.deepEqual(
    events.map((event) => [event.outcome, event.error, event.http_status]),
    [
      ['success', '', 200],
      ['failed', 'tool_error', 200],
      ['failed', 'json_rpc_error', 200],
    ],
  );
  assert.ok(
    events.every(
      (event) => event.duration_ms !== null && event.input === null && event.output === null && event.detail,
    ),
  );
});

test('content capture requires service opt-in, redacts secrets, and honors the global off switch', async (t) => {
  const f = await fixture(t);
  f.cfg.monitoringLogsEnabled = true;
  await f.rpc('tools/call', { name: 'fast', arguments: { query: 'private text', password: 'never-store' } });
  const captured = f.events.at(-1)!;
  assert.equal(JSON.parse(captured.input!).arguments.password, '[REDACTED]');
  assert.equal(JSON.parse(captured.output!).api_key, '[REDACTED]');
  assert.equal(JSON.stringify(f.events).includes('never-store'), false);
  applySystemSettings({ ...currentSystemSettings(), monitoring_logs_enabled: false });
  await f.rpc('tools/call', { name: 'fast', arguments: { query: 'not captured' } });
  assert.equal(f.events.at(-1)!.input, null);
  assert.equal(f.events.at(-1)!.output, null);
  assert.equal(f.events.at(-1)!.detail, false);
});

test('a late tool result never recreates a session deleted during execution', async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setGate(async () => {
    entered();
    await waiting;
  });
  const pending = f.rpc('tools/call', { name: 'slow' }).then((r: any) => r);
  try {
    await started;
    assert.equal((await f.remove()).statusCode, 204);
  } finally {
    release();
  }
  assert.equal((await pending).statusCode, 200);
  assert.equal(await f.store.get(f.key), null);
});

test('credential rejection provides reconnection guidance and reports only the saved credential version', async (t) => {
  const f = await fixture(t);
  f.reject();
  const rejected = await f.rpc('tools/call', { name: 'fast' });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error, 'upstream_credential_rejected');
  assert.equal(rejected.json().connect_url, env.connectionsWebUrl);
  assert.equal(f.reports.at(-1).status, 'rejected');
  assert.equal(f.reports.at(-1).credential_version, 'a'.repeat(64));
  assert.equal(JSON.stringify(f.reports).includes('private-upstream-key'), false);
});

test('replacing a personal credential initializes a new upstream session without changing tool routes', async (t) => {
  const f = await fixture(t);
  const before = JSON.parse((await f.store.get(f.key))!).toolRoutes;
  f.replaceKey();
  assert.equal((await f.rpc('tools/call', { name: 'fast' })).statusCode, 200);
  assert.equal(f.initializes(), 2);
  assert.deepEqual(JSON.parse((await f.store.get(f.key))!).toolRoutes, before);
});
