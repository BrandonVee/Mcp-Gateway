import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClientIp } from '../packages/auth-server/src/shared/http/client-ip.js';

test('rate limiting ignores spoofed forwarded addresses from an untrusted socket', () => {
  assert.equal(resolveClientIp('198.51.100.12', '203.0.113.4', '198.51.100.10'), '198.51.100.12');
  assert.equal(resolveClientIp('::ffff:198.51.100.12', '203.0.113.4', ''), '198.51.100.12');
});

test('rate limiting uses the first untrusted address in a trusted proxy chain', () => {
  assert.equal(
    resolveClientIp('198.51.100.10', '203.0.113.4, 198.51.100.11', '198.51.100.10,198.51.100.11'),
    '203.0.113.4',
  );
  assert.equal(
    resolveClientIp('198.51.100.10', 'invalid, 198.51.100.11', '198.51.100.10,198.51.100.11'),
    '198.51.100.10',
  );
  assert.equal(resolveClientIp('172.19.0.3', '203.0.113.4, 172.19.0.2', '172.19.0.0/24'), '203.0.113.4');
});
