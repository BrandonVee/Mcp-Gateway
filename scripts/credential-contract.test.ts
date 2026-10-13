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
