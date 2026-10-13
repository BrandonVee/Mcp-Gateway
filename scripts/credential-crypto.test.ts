import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptCredential,
  encryptCredential,
} from '../packages/auth-server/src/infrastructure/security/credential-crypto.js';

test('credential encryption is randomized and authenticated', () => {
  process.env.CREDENTIAL_ENCRYPT_KEY = '0123456789abcdef'.repeat(4);
  const first = encryptCredential('user-owned-secret');
  const second = encryptCredential('user-owned-secret');
  assert.notEqual(first, second);
  assert.equal(decryptCredential(first), 'user-owned-secret');
  assert.equal(decryptCredential(second), 'user-owned-secret');
  const parts = first.split(':');
  parts[2] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptCredential(parts.join(':')));
});

test('credential encryption requires a 256-bit key', () => {
  process.env.CREDENTIAL_ENCRYPT_KEY = 'too-short';
  assert.throws(() => encryptCredential('secret'), /32-byte hex key/);
});
