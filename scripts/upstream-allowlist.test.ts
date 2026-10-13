import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySystemSettings, currentSystemSettings, normalizeUpstreamEndpoint } from '@/shared/index.js';
import { refreshServerConfigs, serverConfigs } from '@/gateway/config.js';
import { validateMcpEndpoint } from '@/auth/modules/upstreams/endpoint-validation.js';
import { normalizeUpstreamHost } from '@/shared/index.js';

const endpoint = 'http://38.58.57.4:8765/mcp/hscode';

test('registration distinguishes an untrusted host from malformed URLs and Gateway loops', () => {
  const env = { MCP_UPSTREAM_ALLOWLIST_ENABLED: 'true', MCP_UPSTREAM_ALLOWED_HOSTS: 'trusted.example.com' };
  const gateway = 'https://gateway.example.com';
  assert.deepEqual(validateMcpEndpoint(endpoint, env, gateway), {
    error: 'upstream_host_not_allowed',
    host: '38.58.57.4',
  });
  assert.deepEqual(validateMcpEndpoint('https://TRUSTED.example.com:8443', env, gateway), {
    url: 'https://trusted.example.com:8443/mcp',
  });
  for (const value of [
    undefined,
    42,
    'invalid',
    'file:///etc/passwd',
    'https://user:secret@other.example/mcp',
    `${endpoint}#fragment`,
  ])
    assert.deepEqual(validateMcpEndpoint(value, env, gateway), { error: 'invalid_upstream_endpoint' });
  for (const path of ['/', '/mcp', '/mcp/service'])
    assert.deepEqual(validateMcpEndpoint(gateway + path, env, gateway), { error: 'gateway_self_referential_endpoint' });
  assert.deepEqual(validateMcpEndpoint(endpoint, { ...env, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'false' }, gateway), {
    url: endpoint,
  });
});

test('quick-add accepts hostnames and IPs while rejecting schemes, ports and paths', () => {
  for (const host of ['mcp-a', '192.168.1.10', 'api.example.com']) assert.equal(normalizeUpstreamHost(host), host);
  assert.equal(normalizeUpstreamHost(' API.Example.Com '), 'api.example.com');
  for (const value of [
    null,
    42,
    '',
    'https://api.example.com',
    'api.example.com:443',
    'api.example.com/mcp',
    'api..example.com',
  ])
    assert.equal(normalizeUpstreamHost(value), null);
});

test('explicit allowlist policy applies in both production and development', () => {
  for (const NODE_ENV of ['production', 'development']) {
    const enabled = { NODE_ENV, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'true', MCP_UPSTREAM_ALLOWED_HOSTS: '38.58.57.4' };
    assert.equal(normalizeUpstreamEndpoint(endpoint, enabled), endpoint);
    assert.equal(normalizeUpstreamEndpoint('https://other.example.com/mcp', enabled), null);
    assert.equal(normalizeUpstreamEndpoint(endpoint, { ...enabled, MCP_UPSTREAM_ALLOWED_HOSTS: '' }), null);
    const disabled = { ...enabled, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'false' };
    assert.equal(normalizeUpstreamEndpoint('https://other.example.com', disabled), 'https://other.example.com/mcp');
    assert.equal(normalizeUpstreamEndpoint(endpoint, { ...disabled, MCP_UPSTREAM_ALLOWED_HOSTS: '' }), endpoint);
    for (const invalid of [
      'not a URL',
      'file:///etc/passwd',
      'https://user:secret@other.example.com/mcp',
      `${endpoint}#fragment`,
    ]) {
      assert.equal(normalizeUpstreamEndpoint(invalid, disabled), null);
    }
  }
});

test('missing switch preserves the existing environment policy', () => {
  assert.equal(normalizeUpstreamEndpoint(endpoint, { NODE_ENV: 'production' }), null);
  assert.equal(normalizeUpstreamEndpoint(endpoint, { NODE_ENV: 'development' }), endpoint);
  assert.equal(
    normalizeUpstreamEndpoint(endpoint, { NODE_ENV: 'development', MCP_UPSTREAM_ALLOWED_HOSTS: 'other.example.com' }),
    null,
  );
});

test('gateway refresh applies the persisted switch, removes blocked routes, and restores them on disable', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSettings = currentSystemSettings();
  const originalServers = new Map(serverConfigs);
  const keys = [
    'NODE_ENV',
    'SYSTEM_CONFIG_MODE',
    'MCP_UPSTREAM_ALLOWED_HOSTS',
    'MCP_UPSTREAM_ALLOWLIST_ENABLED',
  ] as const;
  const originalEnv = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    globalThis.fetch = originalFetch;
    applySystemSettings(originalSettings);
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    serverConfigs.clear();
    for (const [key, value] of originalServers) serverConfigs.set(key, value);
  });
  process.env.NODE_ENV = 'production';
  process.env.SYSTEM_CONFIG_MODE = 'database';
  let settings: Record<string, unknown> = {
    public_url: 'https://mcp.example.com',
    upstream_allowlist_enabled: false,
    upstream_hosts: ['trusted.example.com'],
  };
  const trusted = 'https://trusted.example.com/mcp';
  globalThis.fetch = async () =>
    Response.json({
      system_settings: settings,
      servers: [
        { name: 'hscode', authMode: 'none', instances: [{ id: '1', url: endpoint }] },
        {
          name: 'mixed',
          authMode: 'none',
          instances: [
            { id: '2', url: trusted },
            { id: '3', url: endpoint },
          ],
        },
        { name: 'invalid', authMode: 'none', instances: [{ id: '4', url: 'file:///etc/passwd' }] },
      ],
    });
  await refreshServerConfigs();
  assert.deepEqual(serverConfigs.get('hscode')?.instances, [endpoint]);
  assert.deepEqual(serverConfigs.get('mixed')?.instances, [trusted, endpoint]);
  assert.equal(serverConfigs.has('invalid'), false);
  assert.deepEqual(currentSystemSettings().upstream_hosts, ['trusted.example.com']);

  settings = { ...settings, upstream_allowlist_enabled: true };
  await refreshServerConfigs();
  assert.equal(serverConfigs.has('hscode'), false);
  assert.deepEqual(serverConfigs.get('mixed')?.instances, [trusted]);

  settings = { ...settings, upstream_hosts: [] };
  await refreshServerConfigs();
  assert.equal(serverConfigs.size, 0, 'enabled empty list removes all cached routes');

  settings = { ...settings, upstream_allowlist_enabled: false };
  await refreshServerConfigs();
  assert.equal(serverConfigs.has('hscode'), true);

  delete settings.upstream_allowlist_enabled;
  await refreshServerConfigs();
  assert.equal(currentSystemSettings().upstream_allowlist_enabled, true, 'legacy database settings default to enabled');
  assert.equal(serverConfigs.size, 0);
});
