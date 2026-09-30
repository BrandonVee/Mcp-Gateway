import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeUpstreamEndpoint, validateProductionRuntime, type PlatformConfig } from '../packages/shared/src/index.js';
import { filterRequestHeaders, filterResponseHeaders } from '../packages/gateway/src/routes/headers.js';
import { isAllowedMcpOrigin, mcpCorsHeaders } from '../packages/gateway/src/routes/origin.js';
import { activeUpstreamRequests, maxActiveUpstreamRequests, reserveUpstreamSlot } from '../packages/gateway/src/routes/capacity.js';
import { isRetryableInitialize, orderedAvailableInstances, probeUpstreamTransport, UpstreamHealthTracker } from '../packages/gateway/src/upstream-health.js';

const localConfig = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8')) as PlatformConfig;
const productionConfig: PlatformConfig = {
  ...localConfig,
  auth: { ...localConfig.auth, issuer: 'https://auth.example.test' },
  gateway: { ...localConfig.gateway, resourceBaseUrl: 'https://gateway.example.test' },
};
const internalToken = randomBytes(32).toString('hex');
const brokerToken = randomBytes(32).toString('hex');
const productionEnv = {
  NODE_ENV: 'production', CONFIG_FILE: '/etc/mcp/production.json',
  DATABASE_URL: 'postgres://app:private@db.example.test/mcp', REDIS_URL: 'rediss://redis.example.test',
  INTERNAL_API_TOKEN: internalToken, CREDENTIAL_BROKER_TOKEN: brokerToken, CREDENTIAL_ENCRYPT_KEY: randomBytes(32).toString('hex'),
  ADMIN_WEB_URL: 'https://admin.example.test', CONNECTIONS_WEB_URL: 'https://admin.example.test/connections',
  MCP_UPSTREAM_ALLOWED_HOSTS: 'mcp.internal.example.test',
};

test('production runtime rejects development defaults and missing secrets', () => {
  assert.doesNotThrow(() => validateProductionRuntime(localConfig, 'auth', { NODE_ENV: 'development' }));
  assert.throws(() => validateProductionRuntime(localConfig, 'auth', productionEnv), /auth\.issuer/);
  assert.doesNotThrow(() => validateProductionRuntime(productionConfig, 'auth', productionEnv));
  assert.doesNotThrow(() => validateProductionRuntime(productionConfig, 'gateway', productionEnv));
  assert.throws(() => validateProductionRuntime(productionConfig, 'auth', { ...productionEnv, CREDENTIAL_ENCRYPT_KEY: '' }), /CREDENTIAL_ENCRYPT_KEY/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'auth', { ...productionEnv, DATABASE_URL: 'postgres://mcp:mcp-dev-password@db/mcp' }), /development password/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'auth', { ...productionEnv, DATABASE_URL: 'postgres://mcp:mcp%2Ddev-password@db/mcp' }), /development password/);
  assert.throws(() => validateProductionRuntime({ ...productionConfig, auth: { ...productionConfig.auth, issuer: 'https://auth.example.test/path' } }, 'auth', productionEnv), /auth\.issuer/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'auth', { ...productionEnv, CREDENTIAL_ENCRYPT_KEY: '9f52ebfcbdfb3f52cfcf214b6196952c486efe7ec2c1d7f7a2144d72428c01fc' }), /development default/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, CREDENTIAL_BROKER_TOKEN: 'ef23e6d931a69ad96a57d9ba38a39c810d6adb8a61f4e38990a9b14e0bc6a36d' }), /development default/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, CREDENTIAL_BROKER_TOKEN: internalToken }), /must differ/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, REDIS_URL: '' }), /REDIS_URL/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, MCP_UPSTREAM_ALLOWED_HOSTS: '' }), /MCP_UPSTREAM_ALLOWED_HOSTS/);
  assert.throws(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, MCP_UPSTREAM_ALLOWED_HOSTS: 'https://mcp.example.test' }), /MCP_UPSTREAM_ALLOWED_HOSTS/);
  assert.doesNotThrow(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'false', MCP_UPSTREAM_ALLOWED_HOSTS: '' }));
  assert.doesNotThrow(() => validateProductionRuntime(productionConfig, 'auth', { ...productionEnv, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'false', MCP_UPSTREAM_ALLOWED_HOSTS: '' }));
  assert.throws(() => validateProductionRuntime(productionConfig, 'gateway', { ...productionEnv, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'invalid' }), /MCP_UPSTREAM_ALLOWLIST_ENABLED/);
});

test('upstream endpoints require approved hosts in production and reject URL credentials', () => {
  const env = { NODE_ENV: 'production', MCP_UPSTREAM_ALLOWED_HOSTS: 'mcp.internal.example.test' };
  assert.equal(normalizeUpstreamEndpoint('https://mcp.internal.example.test', env), 'https://mcp.internal.example.test/mcp');
  assert.equal(normalizeUpstreamEndpoint('https://other.example.test/mcp', env), null);
  assert.equal(normalizeUpstreamEndpoint('https://user:secret@mcp.internal.example.test/mcp', env), null);
  assert.equal(normalizeUpstreamEndpoint('https://mcp.internal.example.test/mcp#fragment', env), null);
  assert.equal(normalizeUpstreamEndpoint('file:///etc/passwd', env), null);
});

test('MCP origin check accepts only the gateway or configured browser origins', () => {
  const base = 'https://gateway.example.test';
  assert.equal(isAllowedMcpOrigin(undefined, base), true);
  assert.equal(isAllowedMcpOrigin(base, base), true);
  assert.equal(isAllowedMcpOrigin('https://client.example.test', base, 'https://client.example.test'), true);
  assert.equal(isAllowedMcpOrigin('https://evil.example.test', base), false);
  assert.equal(isAllowedMcpOrigin('null', base), false);
  assert.equal(isAllowedMcpOrigin('https://gateway.example.test.evil.test', base), false);
  assert.equal(isAllowedMcpOrigin('https://client.example.test', base, 'https://client.example.test/path'), false);
  assert.equal(mcpCorsHeaders('https://client.example.test', base)['access-control-allow-origin'], undefined);
  assert.equal(mcpCorsHeaders(base, base)['access-control-allow-origin'], base);
});

test('upstream capacity releases slots exactly once', () => {
  const releases = Array.from({ length: maxActiveUpstreamRequests }, () => reserveUpstreamSlot());
  assert.ok(releases.every(Boolean));
  assert.equal(activeUpstreamRequests(), maxActiveUpstreamRequests);
  assert.equal(reserveUpstreamSlot(), null);
  for (const release of releases) release?.();
  releases[0]?.();
  assert.equal(activeUpstreamRequests(), 0);
});

test('unhealthy upstreams are skipped in order and recover after a successful probe', () => {
  const health = new UpstreamHealthTracker(1_000);
  const instances = ['http://first.test/mcp', 'http://second.test/mcp', 'http://third.test/mcp'];
  assert.deepEqual(orderedAvailableInstances(instances, 1, health), [instances[1], instances[2], instances[0]]);
  const now = Date.now();
  health.recordFailure(instances[1], 'transport', now);
  assert.equal(health.isAvailable(instances[1], now + 100), false);
  assert.deepEqual(orderedAvailableInstances(instances, 1, health), [instances[2], instances[0]]);
  assert.equal(health.isAvailable(instances[1], now + 1_000), true);
  health.recordSuccess(instances[1]);
  assert.equal(health.unavailableCount(instances), 0);
  health.recordFailure(instances[2], 'http');
  health.recordSuccess(instances[2], 'probe');
  assert.equal(health.isAvailable(instances[2]), false, 'a TCP probe does not clear an HTTP failure');
  health.recordSuccess(instances[2]);
  assert.equal(health.isAvailable(instances[2]), true);
  assert.deepEqual(orderedAvailableInstances([], 0, health), []);
});

test('only session-free initialize messages may retry on another instance', () => {
  const initialize = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  assert.equal(isRetryableInitialize('POST', undefined, initialize), true);
  assert.equal(isRetryableInitialize('POST', 'existing-session', initialize), false);
  assert.equal(isRetryableInitialize('POST', undefined, Buffer.from('{"method":"tools/call"}')), false);
  assert.equal(isRetryableInitialize('GET', undefined, initialize), false);
  assert.equal(isRetryableInitialize('POST', undefined, Buffer.from('not-json')), false);
});

test('upstream transport probe detects a reachable TCP endpoint', async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(await probeUpstreamTransport(`http://127.0.0.1:${address.port}/mcp`), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('gateway strips caller credentials and spoofed identity headers', () => {
  assert.deepEqual(filterRequestHeaders({
    host: 'gateway.example.test', authorization: 'Bearer platform-token', cookie: 'auth_session=secret',
    'x-mcp-user': 'spoofed', 'x-mcp-role': 'admin', 'x-forwarded-client-cert': 'spoofed',
    forwarded: 'for=spoofed', connection: 'keep-alive, x-custom-hop', 'x-custom-hop': 'hidden',
    'mcp-session-id': 'session-id', accept: 'text/event-stream', origin: 'https://gateway.example.test',
  }), { 'mcp-session-id': 'session-id', accept: 'text/event-stream' });
  assert.deepEqual(filterResponseHeaders({ 'set-cookie': ['upstream=a', 'other=b'], 'content-type': 'text/event-stream' }), {
    'content-type': 'text/event-stream',
  });
});
