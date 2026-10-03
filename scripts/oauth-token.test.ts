import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAccessToken } from './oauth-token.js';

test('CLI dynamically registers a client and exchanges a PKCE code for an existing user', async (t) => {
  const originalFetch = globalThis.fetch;
  const previousUser = process.env.MCP_USER;
  const previousPassword = process.env.MCP_PASSWORD;
  process.env.MCP_USER = 'existing-user';
  process.env.MCP_PASSWORD = 'existing-password';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousUser === undefined) delete process.env.MCP_USER;
    else process.env.MCP_USER = previousUser;
    if (previousPassword === undefined) delete process.env.MCP_PASSWORD;
    else process.env.MCP_PASSWORD = previousPassword;
  });
  let state = '';
  let challenge = '';
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    const url = new URL(String(input));
    if (url.pathname === '/register') {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)).redirect_uris, ['http://localhost:8080/callback']);
      return Response.json({ client_id: 'registered-client' }, { status: 201 });
    }
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('client_id'), 'registered-client');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      state = url.searchParams.get('state')!;
      challenge = url.searchParams.get('code_challenge')!;
      return new Response(`<input name="state" value="${state}"><input name="client_id" value="registered-client">`);
    }
    if (url.pathname === '/authorize/submit') {
      const form = init?.body as URLSearchParams;
      assert.equal(form.get('username'), 'existing-user');
      assert.equal(form.get('password'), 'existing-password');
      assert.equal(form.get('state'), state);
      assert.equal(init?.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { location: `http://localhost:8080/callback?code=test-code&state=${state}` },
      });
    }
    assert.equal(url.pathname, '/token');
    const form = init?.body as URLSearchParams;
    assert.equal(form.get('client_id'), 'registered-client');
    assert.equal(form.get('code'), 'test-code');
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge);
    return Response.json({ access_token: 'test-token', expires_in: 3600 });
  };
  assert.deepEqual(await getAccessToken(), { access_token: 'test-token', expires_in: 3600 });
  assert.equal(requests, 4);
});

test('CLI requires real credentials instead of falling back to a demo account', async (t) => {
  const previousUser = process.env.MCP_USER;
  delete process.env.MCP_USER;
  t.after(() => {
    if (previousUser !== undefined) process.env.MCP_USER = previousUser;
  });
  await assert.rejects(getAccessToken(), /Set MCP_USER and MCP_PASSWORD/);
});
