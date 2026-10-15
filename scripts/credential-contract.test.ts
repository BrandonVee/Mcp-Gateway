import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bearerTokenMatches } from '@/shared/security/bearer.js';
import {
  credentialHeaderSchema,
  upstreamCredentialResponseSchema,
  isValidApiKeyPrefix,
} from '@/shared/security/credentials.js';
import { upstreamTestCredentialSchema } from '@/shared/upstream-test.js';
import { createPkceAuthorization } from '@/auth/shared/security/pkce.js';
import { connectionStatus } from '@/auth/modules/upstreams/connection-status.js';
import { serverPatchSchema } from '@/auth/modules/admin/validation.js';
import { toolCallCount } from '@/gateway/transport-policy.js';

test('credential brokers reject malformed responses and header injection while allowing long OAuth tokens', () => {
  for (const credential of [
    undefined,
    false,
    '',
    { header: 'cookie', value: 'key' },
    { header: 'authorization', value: 'key\r\nx-leak: yes' },
    { header: 'x-api-key', value: '' },
  ]) {
    assert.equal(upstreamCredentialResponseSchema.safeParse({ revision: 1, credential }).success, false);
  }
  assert.equal(upstreamCredentialResponseSchema.safeParse({ revision: 1, credential: null }).success, true);
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(upstreamCredentialResponseSchema.safeParse({ revision, credential: null }).success, false);
  }
  const longOAuth = { header: 'authorization', value: 'Bearer ' + 'a'.repeat(5000) };
  assert.equal(credentialHeaderSchema.safeParse(longOAuth).success, true);
  assert.equal(upstreamTestCredentialSchema.safeParse(longOAuth).success, false);
  assert.equal(isValidApiKeyPrefix('Bearer '), true);
  assert.equal(isValidApiKeyPrefix(''), true);
  assert.equal(isValidApiKeyPrefix('a'.repeat(101)), false);
  assert.equal(isValidApiKeyPrefix('\n'), false);
});

test('internal bearer authentication fails closed for absent, empty and incorrect secrets', () => {
  assert.equal(bearerTokenMatches('Bearer secret', 'secret'), true);
  for (const [header, expected] of [
    [undefined, 'secret'],
    ['secret', 'secret'],
    ['Bearer secret', undefined],
    ['Bearer ', ''],
    ['Bearer wrong', 'secret'],
  ]) {
    assert.equal(bearerTokenMatches(header, expected), false);
  }
});

test('PKCE flows use independent unpredictable state and an S256 challenge of the verifier', () => {
  const first = createPkceAuthorization(),
    second = createPkceAuthorization();
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.state, first.verifier);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'));
});

test('saved keys remain unverified until accepted, rejected credentials stay actionable, and OAuth expiry is distinct', () => {
  const row = { mode: 'api_key', expiresAt: null, hasRefreshToken: false, validationStatus: 'saved' as const };
  assert.equal(connectionStatus('api_key', row), 'saved');
  assert.equal(connectionStatus('api_key', { ...row, validationStatus: 'verified' }), 'connected');
  assert.equal(connectionStatus('api_key', { ...row, validationStatus: 'rejected' }), 'rejected');
  assert.equal(connectionStatus('oauth', { ...row, mode: 'oauth', expiresAt: Date.now() - 1 }), 'expired');
  assert.equal(
    connectionStatus('oauth', { ...row, mode: 'oauth', expiresAt: Date.now() - 1, hasRefreshToken: true }),
    'connected',
  );
  assert.equal(connectionStatus('system_api_key'), 'not_required');
});

test('service limits reject negative, fractional and excessive values, and zero explicitly disables limits', () => {
  assert.equal(
    serverPatchSchema.safeParse({ user_daily_quota: 0, user_rate_limit_per_minute: 0, user_max_concurrent: 0 }).success,
    true,
  );
  for (const patch of [
    { user_daily_quota: -1 },
    { user_max_concurrent: 1.5 },
    { user_rate_limit_per_minute: 100001 },
    { user_daily_quota: '100' },
    { monitoring_logs_enabled: 'true' },
  ])
    assert.equal(serverPatchSchema.safeParse(patch).success, false);
});

test('daily quota includes every tool in legacy JSON-RPC batches and excludes discovery', () => {
  const batch = [{ method: 'tools/call' }, { method: 'tools/list' }, { method: 'tools/call' }];
  assert.equal(toolCallCount(Buffer.from(JSON.stringify(batch))), 2);
  assert.equal(toolCallCount({ method: 'tools/call' }), 1);
  assert.equal(toolCallCount(Buffer.from('invalid')), 0);
});
