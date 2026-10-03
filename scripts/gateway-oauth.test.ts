import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { registerDevelopmentOAuthRoutes } from '../packages/gateway/src/routes/oauth.js';

const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');

test('local Gateway discovers Auth, proxies public OAuth bodies and redirects browser authorization', async () => {
  const received: Array<{ path: string; body: string; cookie?: string }> = [];
  const auth = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url!, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream-cookie=private' });
    res.end(JSON.stringify({ issuer: 'http://auth.example.test', endpoint: req.url }));
  });
  await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve));
  const address = auth.address();
  assert.ok(address && typeof address !== 'string');
  const app = Fastify();
  // Match the Gateway parsers: proxy request bytes without JSON reserialization.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req: unknown, body: Buffer, done: Function) =>
    done(null, body),
  );
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req: unknown, body: Buffer, done: Function) =>
    done(null, body),
  );
  registerDevelopmentOAuthRoutes(app, {
    authUrl: `http://127.0.0.1:${address.port}`,
    authIssuer: () => 'http://auth.example.test',
    production: false,
  });
  try {
    for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/jwks.json']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().issuer, 'http://auth.example.test');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['set-cookie'], undefined);
    }
    const registration = '{ "redirect_uris": ["http://127.0.0.1:55945/oauth/callback"] }';
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/register',
          headers: { 'content-type': 'application/json', cookie: 'auth_session=private' },
          payload: registration,
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(received.at(-1), { path: '/register', body: registration, cookie: undefined });
    const token = 'grant_type=authorization_code&code=one-time-code&code_verifier=verifier';
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: token,
        })
      ).statusCode,
      200,
    );
    assert.equal(received.at(-1)?.body, token);
    const authorize = await app.inject({
      method: 'GET',
      url: '/authorize?state=test-state&resource=http%3A%2F%2Flocalhost%3A8000%2Fmcp%2Fhscode',
    });
    assert.equal(authorize.statusCode, 307);
    const destination = new URL(authorize.headers.location!);
    assert.equal(destination.origin, 'http://auth.example.test');
    assert.equal(destination.searchParams.get('state'), 'test-state');
    assert.equal(destination.searchParams.get('resource'), 'http://localhost:8000/mcp/hscode');
    assert.equal((await app.inject({ method: 'GET', url: '/internal/mcp-servers' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/admin/users' })).statusCode, 404);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => auth.close((error) => (error ? reject(error) : resolve())));
  }
});

test('production does not enable development OAuth aliases', async () => {
  const app = Fastify();
  registerDevelopmentOAuthRoutes(app, {
    authUrl: 'http://127.0.0.1:1',
    authIssuer: () => 'https://auth.example.test',
    production: true,
  });
  try {
    for (const [method, url] of [
      ['GET', '/.well-known/openid-configuration'],
      ['POST', '/register'],
      ['POST', '/token'],
    ]) {
      assert.equal((await app.inject({ method, url })).statusCode, 404);
    }
  } finally {
    await app.close();
  }
});
