/** Real PostgreSQL, HTTP auth and MCP regressions in an isolated schema. Redis sessions stay in memory. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlatformConfig } from '@/shared/index.js';
import { createIsolatedAuthSchema } from '@/scripts/isolated-auth-schema.js';

async function main() {
  const original = loadPlatformConfig();
  const isolated = await createIsolatedAuthSchema();
  const cleanup: Array<() => Promise<unknown>> = [isolated.cleanup];
  try {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-access-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const require = createRequire(new URL('../packages/auth-server/package.json', import.meta.url));
    const { Hono } = require('hono');
    const { serve } = require('@hono/node-server');
    const { SignJWT } = require('jose');
    const app = new Hono();
    const control: any = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    cleanup.push(() => new Promise<void>((resolve) => control.close(() => resolve())));
    if (!control.listening) await new Promise((resolve) => control.once('listening', resolve));
    const origin = `http://127.0.0.1:${control.address().port}`;
    process.env.DATABASE_URL = isolated.databaseUrl;
    process.env.SYSTEM_CONFIG_MODE = 'file';
    process.env.NODE_ENV = 'development';
    process.env.CREDENTIAL_BROKER_TOKEN = 'isolated-access-broker';
    process.env.INTERNAL_API_TOKEN = 'isolated-access-internal';
    process.env.CREDENTIAL_ENCRYPT_KEY = 'a'.repeat(64);
    process.env.MCP_UPSTREAM_ALLOWLIST_ENABLED = 'false';
    delete process.env.AUTH_RSA_PRIVATE_KEY_PEM;
    delete process.env.AUTH_RSA_PUBLIC_KEY_PEM;
    process.env.CONFIG_FILE = join(directory, 'config.json');
    await writeFile(
      process.env.CONFIG_FILE,
      JSON.stringify({
        ...original,
        auth: { ...original.auth, issuer: origin },
        gateway: {
          ...original.gateway,
          resourceBaseUrl: origin,
          registryUrl: `${origin}/internal/mcp-servers`,
          authJwksUrl: `${origin}/jwks.json`,
        },
      }),
    );
    const { db, pool } = await import('@/auth/infrastructure/database/client.js');
    cleanup.push(() => pool.end());
    const { users, userApiKeys } = await import('@/auth/infrastructure/database/schema.js');
    const { createLoginSession } = await import('@/auth/modules/identity/sessions.js');
    const { loadSigningKeys } = await import('@/auth/modules/oauth/keys.js');
    const { createAdminRouter } = await import('@/auth/modules/admin/router.js');
    const { createConnectionsRouter } = await import('@/auth/modules/connections/router.js');
    const { createRegistryRouter } = await import('@/auth/modules/upstreams/registry.js');
    const { revokeUserAuthentication } = await import('@/auth/modules/identity/authentication.js');
    const { env, refreshServerConfigs } = await import('@/gateway/config.js');
    const { authHook } = await import('@/gateway/auth.js');
    const { redis } = await import('@/gateway/lb.js');
    const { registerMcpRoutes } = await import('@/gateway/routes/mcp.js');
    const { registerMetadataRoutes } = await import('@/gateway/routes/metadata.js');
    const { eq } = require('drizzle-orm');
    redis.disconnect();
    cleanup.push(async () => redis.disconnect());
    const memory = new Map<string, string>();
    redis.get = (async (key: string) => memory.get(key) ?? null) as any;
    redis.set = (async (key: string, value: string, ...options: unknown[]) => {
      if (options.includes('NX') && memory.has(key)) return null;
      memory.set(key, value);
      return 'OK';
    }) as any;
    redis.del = (async (key: string) => Number(memory.delete(key))) as any;
    redis.expire = (async (key: string) => Number(memory.has(key))) as any;
    redis.eval = (async (script: string, count: number, ...values: (string | number)[]) => {
      assert.equal(count, 2, 'zero default limits must not reserve user quotas');
      if (script.includes('local owner =')) {
        const [binding, owner, action, user, , url] = values.map(String);
        if (action === 'bind') {
          memory.set(binding, url);
          memory.set(owner, user);
          return 1;
        }
        if (memory.get(owner) !== user || !memory.has(binding)) return 0;
        if (action === 'remove') {
          memory.delete(binding);
          memory.delete(owner);
        }
        return 1;
      }
      const [key, guard, expected, updated, , token] = values.map(String);
      if (memory.get(key) !== expected) return 0;
      if (guard !== key && memory.get(guard) !== token) return -1;
      memory.set(key, updated);
      return 1;
    }) as any;
    const upstreamCalls: Array<{ path: string; authorization?: string; key?: string }> = [];
    const upstream = createServer(async (req, res) => {
      if (req.method === 'DELETE') {
        res.writeHead(204).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      upstreamCalls.push({
        path: req.url!,
        authorization: req.headers.authorization,
        key: req.headers['x-api-key'] as string,
      });
      if (req.url === '/public' && req.headers['x-api-key'] !== 'isolated-shared-upstream-key') {
        res.writeHead(401).end('{}');
        return;
      }
      if (rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : rpc.method === 'tools/list'
            ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'ok' }] };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');
    const gateway = Fastify();
    cleanup.push(() => gateway.close());
    gateway.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req: unknown, body: Buffer, done: Function) => done(null, body),
    );
    gateway.addHook('onRequest', authHook);
    registerMcpRoutes(gateway);
    registerMetadataRoutes(gateway);
    const signing = await loadSigningKeys();
    app.route('/', createAdminRouter({ keys: signing, issuer: origin }));
    app.route('/', createConnectionsRouter());
    app.route('/', createRegistryRouter());
    app.get('/jwks.json', (c: any) => c.json({ keys: [signing.publicJwk] }));
    const accounts = await db
      .insert(users)
      .values(
        ['admin', 'alice', 'bob'].map((name, i) => ({
          username: name,
          role: i === 0 ? ('admin' as const) : ('user' as const),
          passwordHash: 'unused',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      )
      .returning();
    const cookies = await Promise.all(
      accounts.map(async (user) => `auth_session=${await createLoginSession(user.id, 0)}`),
    );
    const request = async (path: string, method = 'GET', body?: unknown, who = 0, headers = {}) => {
      const response = await app.request(`${origin}${path}`, {
        method,
        headers: { cookie: cookies[who], 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as any, response };
    };
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const upstreamBase = `http://127.0.0.1:${address.port}`;
    for (const [name, mode] of [
      ['oauth-access', undefined],
      ['key-access', 'api_key'],
      ['public-access', 'none'],
    ] as const) {
      const created = await request('/admin/servers', 'POST', {
        name,
        routing_mode: 'aggregate',
        access_auth_mode: mode,
      });
      assert.equal(created.status, 201);
      assert.equal(created.data.access_auth_mode, mode ?? 'oauth');
      assert.equal(created.data.user_rate_limit_per_minute, 0);
      assert.equal(created.data.user_daily_quota, 0);
      assert.equal(created.data.user_max_concurrent, 0);
      const added = await request(`/admin/servers/${name}/instances`, 'POST', {
        id: `${name}-upstream`,
        url: `${upstreamBase}/${mode === 'none' ? 'public' : name}`,
        auth_mode: mode === 'none' ? 'system_api_key' : 'none',
        ...(mode === 'none'
          ? { system_api_key: 'isolated-shared-upstream-key', api_key_header: 'x-api-key', api_key_prefix: '' }
          : {}),
      });
      assert.equal(added.status, 201);
    }
    assert.equal(
      (
        await request('/admin/servers/public-access/instances', 'POST', {
          url: `${upstreamBase}/private`,
          auth_mode: 'api_key',
        })
      ).status,
      400,
      'public endpoints reject per-user upstream credentials',
    );
    assert.equal(
      (await request(`/admin/users/${accounts[1].id}/servers`, 'PUT', { servers: ['oauth-access', 'key-access'] }))
        .status,
      200,
    );
    const anonymousList = (await request('/me/upstreams', 'GET', undefined, 2)).data.servers;
    assert.ok(
      anonymousList.some((server: any) => server.endpoint_name === 'public-access'),
      'public services appear without a grant',
    );
    assert.ok(!anonymousList.some((server: any) => server.endpoint_name === 'key-access'));
    const issued = await request('/me/api-keys', 'POST', { name: 'Local client' }, 1);
    assert.equal(issued.status, 201);
    assert.match(issued.data.key, /^mcp_key_[\w-]{43}$/);
    assert.equal(issued.response.headers.get('cache-control'), 'no-store');
    assert.equal(
      (await request('/me/api-keys', 'POST', { name: 'bad origin' }, 1, { origin: 'https://untrusted.example' }))
        .status,
      403,
    );
    assert.equal((await request('/internal/api-key-auth', 'POST', { key: issued.data.key })).status, 401);
    const key = issued.data.key;
    const list = await request('/me/api-keys', 'GET', undefined, 1);
    assert.equal(list.data.keys.length, 1);
    assert.ok(!JSON.stringify(list.data).includes(key), 'list never exposes plaintext');
    const [stored] = await db.select().from(userApiKeys).where(eq(userApiKeys.id, issued.data.id));
    assert.equal(stored.keyHash.length, 64);
    assert.notEqual(stored.keyHash, key);
    assert.equal((await request(`/me/api-keys/${issued.data.id}`, 'DELETE', undefined, 2)).status, 404);
    assert.equal(
      (await request('/me/api-keys', 'POST', { name: 'stale' }, 1, { 'x-session-identity': `${accounts[2].id}:0` }))
        .status,
      409,
    );
    const bobKeys = await Promise.all(
      Array.from({ length: 20 }, (_, index) => request('/me/api-keys', 'POST', { name: `client ${index}` }, 2)),
    );
    assert.ok(bobKeys.every((result) => result.status === 201));
    assert.equal(
      (await request('/me/api-keys', 'POST', { name: 'over limit' }, 2)).status,
      400,
      'concurrent creation enforces the per-user key cap',
    );
    await refreshServerConfigs();
    assert.equal(
      (await gateway.inject({ url: '/.well-known/oauth-protected-resource/mcp/oauth-access' })).statusCode,
      200,
    );
    for (const name of ['key-access', 'public-access'])
      assert.equal(
        (await gateway.inject({ url: `/.well-known/oauth-protected-resource/mcp/${name}` })).statusCode,
        404,
        'non-OAuth modes do not advertise an OAuth issuer',
      );
    let rpcId = 0;
    const rpc = (
      server: string,
      method: string,
      authorization?: string,
      session?: string,
      ip = '192.0.2.1',
      params?: unknown,
    ) =>
      gateway.inject({
        method: 'POST',
        url: `/mcp/${server}`,
        remoteAddress: ip,
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
    const challenge = await rpc('oauth-access', 'initialize');
    assert.equal(challenge.statusCode, 401);
    assert.match(challenge.headers['www-authenticate'], /resource_metadata=/);
    const jwt = await new SignJWT({
      uid: accounts[1].id,
      role: 'user',
      auth_version: 0,
      mcp_servers: ['oauth-access', 'key-access'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: signing.kid })
      .setSubject('alice')
      .setIssuer(env.authIssuer)
      .setAudience(env.resourceBaseUrl)
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    assert.equal(
      (await rpc('oauth-access', 'initialize', jwt)).statusCode,
      200,
      'OAuth default still accepts issued JWTs',
    );
    assert.equal(
      (await rpc('key-access', 'initialize', jwt)).statusCode,
      401,
      'API-key mode does not accept an OAuth token',
    );
    const keyed = await rpc('key-access', 'initialize', key);
    assert.equal(keyed.statusCode, 200);
    const keyedSession = keyed.headers['mcp-session-id'];
    assert.equal((await rpc('key-access', 'tools/list', key, keyedSession)).statusCode, 200);
    assert.equal((await rpc('key-access', 'initialize')).statusCode, 401);
    const publicSession = await rpc('public-access', 'initialize');
    assert.equal(publicSession.statusCode, 200);
    const sid = publicSession.headers['mcp-session-id'];
    const tools = await rpc('public-access', 'tools/list', undefined, sid);
    assert.equal(tools.statusCode, 200);
    const tool = tools.json().result.tools[0].name;
    assert.equal(
      (await rpc('public-access', 'tools/call', undefined, sid, '192.0.2.1', { name: tool, arguments: {} })).statusCode,
      200,
    );
    assert.equal(
      (await rpc('public-access', 'tools/list', undefined, sid, '192.0.2.2')).statusCode,
      404,
      'anonymous sessions cannot move to another IP',
    );
    assert.ok(
      upstreamCalls
        .filter((call) => call.path === '/public')
        .every((call) => !call.authorization && call.key === 'isolated-shared-upstream-key'),
    );
    assert.ok(
      upstreamCalls.every((call) => call.authorization !== `Bearer ${key}`),
      'Gateway keys are never forwarded upstream',
    );
    await request(`/admin/users/${accounts[1].id}/servers`, 'PUT', { servers: ['oauth-access'] });
    assert.equal(
      (await rpc('key-access', 'tools/list', key, keyedSession)).statusCode,
      403,
      'removed grants apply immediately',
    );
    await request(`/admin/users/${accounts[1].id}/servers`, 'PUT', { servers: ['oauth-access', 'key-access'] });
    await db.update(users).set({ disabled: true }).where(eq(users.id, accounts[1].id));
    assert.equal(
      (await rpc('key-access', 'tools/list', key, keyedSession)).statusCode,
      401,
      'disabled users cannot use keys',
    );
    await db.update(users).set({ disabled: false }).where(eq(users.id, accounts[1].id));
    assert.equal((await request(`/me/api-keys/${issued.data.id}`, 'DELETE', undefined, 1)).status, 200);
    assert.equal(
      (await rpc('key-access', 'tools/list', key, keyedSession)).statusCode,
      401,
      'revoked keys cannot reuse an existing session',
    );
    const resetKey = await request('/me/api-keys', 'POST', { name: 'reset test' }, 1);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ authVersion: 1 }).where(eq(users.id, accounts[1].id));
      await revokeUserAuthentication(tx, accounts[1].id);
    });
    assert.equal(
      (await rpc('key-access', 'initialize', resetKey.data.key)).statusCode,
      401,
      'password reset revokes keys',
    );
    const before = upstreamCalls.length;
    assert.equal((await request('/admin/servers/public-access', 'PATCH', { access_auth_mode: 'oauth' })).status, 200);
    assert.equal(
      (await rpc('public-access', 'tools/list', undefined, sid)).statusCode,
      403,
      'live policy closes public access before registry refresh',
    );
    assert.equal(upstreamCalls.length, before);
    console.log(
      'Gateway access smoke passed: OAuth, user keys, public MCP, shared upstream credentials, isolation, revocation and zero defaults.',
    );
  } finally {
    for (const close of cleanup.reverse()) await close();
  }
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
