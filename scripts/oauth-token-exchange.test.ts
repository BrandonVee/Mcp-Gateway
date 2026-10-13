import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessTokenValid,
  exchangeOAuthToken,
  OAuthTokenError,
  shouldRefresh,
  tokenExpiry,
} from '../packages/auth-server/src/modules/upstreams/token-exchange.js';

const server = {
  oauthTokenUrl: 'https://provider.example/token',
  oauthClientId: 'client',
  oauthClientSecret: null,
  oauthClientAuthMethod: 'none' as const,
  oauthResource: null,
};
const params = () => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'keep-this-refresh' });
const responds =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    Response.json(body, { status });

test('a short-lived access token without a refresh token remains usable until its actual expiry', () => {
  const now = 10_000;
  const expiry = tokenExpiry({ expires_in: 30 }, now);
  assert.equal(expiry, 40_000);
  assert.equal(shouldRefresh(expiry, false, now), false);
  assert.equal(accessTokenValid(expiry, 39_999), true);
  assert.equal(accessTokenValid(expiry, 40_000), false);
  assert.equal(shouldRefresh(expiry, true, now), true);
  assert.equal(accessTokenValid(null, now), true);
  assert.equal(shouldRefresh(null, true, now), false);
});

test('rate limiting, request timeout, server failure and network failure preserve the refresh grant', async () => {
  for (const status of [408, 429, 500, 502, 503]) {
    await assert.rejects(
      exchangeOAuthToken(server, params(), responds(status, { error: 'invalid_grant' })),
      (error: unknown) => error instanceof OAuthTokenError && !error.permanent,
    );
  }
  await assert.rejects(
    exchangeOAuthToken(server, params(), async () => {
      throw new TypeError('network failed');
    }),
    (error: unknown) => error instanceof OAuthTokenError && !error.permanent,
  );
});

test('only an explicit invalid_grant makes a failed refresh permanent', async () => {
  await assert.rejects(
    exchangeOAuthToken(server, params(), responds(400, { error: 'invalid_grant' })),
    (error: unknown) => error instanceof OAuthTokenError && error.permanent,
  );
  for (const [status, body] of [
    [400, { error: 'invalid_request' }],
    [401, { error: 'invalid_client' }],
    [403, { error: 'access_denied' }],
    [404, {}],
  ] as const) {
    await assert.rejects(
      exchangeOAuthToken(server, params(), responds(status, body)),
      (error: unknown) => error instanceof OAuthTokenError && !error.permanent,
    );
  }
});

test('malformed successful responses cannot discard a refresh token or imply an unlimited expiry', async () => {
  for (const body of [
    null,
    {},
    { access_token: 'bad\nheader' },
    { access_token: 'valid', token_type: 'MAC' },
    ...[null, false, '', 'invalid', -1, Infinity, '1e100'].map((expires_in) => ({ access_token: 'valid', expires_in })),
  ]) {
    await assert.rejects(
      exchangeOAuthToken(server, params(), responds(200, body)),
      (error: unknown) => error instanceof OAuthTokenError && !error.permanent,
    );
  }
  assert.equal(tokenExpiry({ expires_in: '30' }, 100), 30_100);
  assert.equal(tokenExpiry({}, 100), null);
  assert.equal(tokenExpiry({ expires_in: 0 }, 100), 100);
  assert.equal(tokenExpiry({ expires_in: 0.0005 }, 100), 100);
});

test('successful public-client exchange sends client/resource and accepts a rotating refresh token', async () => {
  const body = { access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 };
  const result = await exchangeOAuthToken(
    { ...server, oauthResource: 'https://upstream.example/mcp' },
    params(),
    async (url, options) => {
      assert.equal(url, server.oauthTokenUrl);
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      const requestBody = options?.body as URLSearchParams;
      assert.equal(requestBody.get('client_id'), 'client');
      assert.equal(requestBody.get('refresh_token'), 'keep-this-refresh');
      assert.equal(requestBody.get('resource'), 'https://upstream.example/mcp');
      return Response.json(body);
    },
  );
  assert.deepEqual(result, body);
});
