import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { authHook } from '@/gateway/auth.js';
import { env, serverConfigs } from '@/gateway/config.js';
import { reserveUserRequest } from '@/gateway/routes/user-limits.js';

const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');
const key = `mcp_key_${'a'.repeat(43)}`;
const payload = {
  uid: 1,
  sub: 'alice',
  role: 'user',
  auth_version: 0,
  mcp_servers: ['access-test'],
  client_id: 'api_key:test',
  scope: 'mcp',
};

test('upstream no-auth never makes the Gateway public: OAuth is the entry default', async () => {
  serverConfigs.set('access-test', { name: 'access-test', authMode: 'none', instances: ['http://upstream.test/mcp'] });
  const app = Fastify();
  app.addHook('onRequest', authHook);
  app.get('/mcp/:serverName', async () => ({ ok: true }));
  try {
    const response = await app.inject({ url: '/mcp/access-test' });
    assert.equal(response.statusCode, 401);
    assert.match(response.headers['www-authenticate'], /resource_metadata=/);
  } finally {
    serverConfigs.delete('access-test');
    await app.close();
  }
});

test('user access keys use live authentication, reject revoked keys and fail closed on outages', async (t) => {
  serverConfigs.set('access-test', {
    name: 'access-test',
    accessAuthMode: 'api_key',
    authMode: 'none',
    instances: ['http://upstream.test/mcp'],
  });
  const app = Fastify();
  app.addHook('onRequest', authHook);
  app.get('/mcp/:serverName', async (req: any) => ({ identity: req.mcpAuth, mode: req.mcpAccessMode }));
  let status = 200,
    requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    requests++;
    assert.equal(String(url), env.apiKeyAuthUrl);
    assert.equal(options.headers.authorization, `Bearer ${env.internalApiToken}`);
    assert.deepEqual(JSON.parse(options.body), { key, server: 'access-test' });
    return Response.json(status === 200 ? { payload } : {}, { status });
  });
  try {
    const missing = await app.inject({ url: '/mcp/access-test' });
    assert.equal(missing.statusCode, 401);
    assert.doesNotMatch(
      missing.headers['www-authenticate'],
      /resource_metadata=/,
      'API-key routes must not start an OAuth loop',
    );
    const headers = { authorization: `Bearer ${key}` };
    const accepted = await app.inject({ url: '/mcp/access-test', headers });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().identity.uid, 1);
    assert.equal(accepted.json().mode, 'api_key');
    status = 401;
    assert.equal((await app.inject({ url: '/mcp/access-test', headers })).statusCode, 401);
    status = 403;
    assert.equal((await app.inject({ url: '/mcp/access-test', headers })).statusCode, 403);
    status = 503;
    assert.equal((await app.inject({ url: '/mcp/access-test', headers })).statusCode, 503);
    assert.equal(requests, 4, 'each key request checks current validity');
  } finally {
    serverConfigs.delete('access-test');
    await app.close();
  }
});

test('public entry needs no credential and isolates anonymous identities by connecting IP', async (t) => {
  serverConfigs.set('access-test', {
    name: 'access-test',
    accessAuthMode: 'none',
    authMode: 'none',
    instances: ['http://upstream.test/mcp'],
  });
  const app = Fastify();
  app.addHook('onRequest', authHook);
  app.get('/mcp/:serverName', async (req: any) => ({ uid: req.mcpAuth.uid, anonymous: req.mcpAnonymousId }));
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('anonymous entry must not validate a user credential');
  });
  try {
    const first = await app.inject({ url: '/mcp/access-test', remoteAddress: '192.0.2.1' });
    const second = await app.inject({ url: '/mcp/access-test', remoteAddress: '192.0.2.2' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().uid, 0);
    assert.notEqual(first.json().anonymous, second.json().anonymous);
  } finally {
    serverConfigs.delete('access-test');
    await app.close();
  }
});

test('zero user limits admit traffic without reserving Redis quota', async () => {
  let called = false;
  const permit = await reserveUserRequest(
    {
      eval: async () => {
        called = true;
        throw new Error('unexpected quota reservation');
      },
    } as any,
    { name: 'unlimited', authMode: 'none', instances: [], userLimits: { perMinute: 0, daily: 0, concurrent: 0 } },
    1,
    10000,
  );
  assert.ok('release' in permit);
  await permit.release();
  assert.equal(called, false);
});
