import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { adminWebUrl, applySystemSettings, authIssuer, bootstrapOriginAllowed, currentSystemSettings, gatewayPublicUrl, loadPlatformConfig, normalizeSystemSettings, validateProductionRuntime } from '../packages/shared/src/index.js';

test('development keeps the Vite browser origin after system settings have been saved', () => {
  const previous = currentSystemSettings();
  const hosts = process.env.MCP_UPSTREAM_ALLOWED_HOSTS;
  const allowlist = process.env.MCP_UPSTREAM_ALLOWLIST_ENABLED;
  try {
    applySystemSettings({ public_url: 'https://mcp.example.test', upstream_hosts: [] });
    assert.equal(adminWebUrl({ NODE_ENV: 'development', SYSTEM_CONFIG_MODE: 'database' }), 'http://localhost:5173');
    assert.equal(gatewayPublicUrl({ NODE_ENV: 'development', SYSTEM_CONFIG_MODE: 'database' }), loadPlatformConfig().gateway.resourceBaseUrl);
    assert.equal(authIssuer({ NODE_ENV: 'development', SYSTEM_CONFIG_MODE: 'database' }), loadPlatformConfig().auth.issuer);
    assert.equal(adminWebUrl({ NODE_ENV: 'development', SYSTEM_CONFIG_MODE: 'database', ADMIN_WEB_URL: 'http://127.0.0.1:5173' }), 'http://127.0.0.1:5173');
    // Production continues to trust the saved public origin, not a development URL.
    assert.equal(adminWebUrl({ NODE_ENV: 'production', SYSTEM_CONFIG_MODE: 'database', ADMIN_WEB_URL: 'http://localhost:5173' }), 'https://mcp.example.test');
    assert.equal(gatewayPublicUrl({ NODE_ENV: 'production', SYSTEM_CONFIG_MODE: 'database' }), 'https://mcp.example.test');
    assert.equal(authIssuer({ NODE_ENV: 'production', SYSTEM_CONFIG_MODE: 'database' }), 'https://mcp.example.test');
    assert.equal(adminWebUrl({ NODE_ENV: 'production', SYSTEM_CONFIG_MODE: 'file', ADMIN_WEB_URL: 'https://admin.example.test' }), 'https://admin.example.test');
  } finally {
    applySystemSettings(previous);
    if (hosts === undefined) delete process.env.MCP_UPSTREAM_ALLOWED_HOSTS;
    else process.env.MCP_UPSTREAM_ALLOWED_HOSTS = hosts;
    if (allowlist === undefined) delete process.env.MCP_UPSTREAM_ALLOWLIST_ENABLED;
    else process.env.MCP_UPSTREAM_ALLOWLIST_ENABLED = allowlist;
  }
});

test('system settings accept a canonical HTTPS origin and exact upstream hosts', () => {
  assert.deepEqual(normalizeSystemSettings({ public_url: 'https://MCP.example.com:443/', upstream_hosts: ['Search.example.com', 'search.example.com'] }, true), {
    public_url: 'https://mcp.example.com', upstream_allowlist_enabled: true, upstream_hosts: ['search.example.com'],
  });
  for (const public_url of ['http://mcp.example.com', 'https://user:password@mcp.example.com', 'https://mcp.example.com/path', 'https://mcp.example.com?token=secret', 'https://mcp.example.com#fragment']) {
    assert.equal(normalizeSystemSettings({ public_url, upstream_hosts: [] }, true), null);
  }
  for (const host of ['*', 'https://search.example.com', 'search.example.com:443', 'search.example.com/path', 'search..example.com']) {
    assert.equal(normalizeSystemSettings({ public_url: 'https://mcp.example.com', upstream_hosts: [host] }, true), null);
  }
});

test('system settings retain the explicit allowlist switch and reject non-boolean values', () => {
  const settings = { public_url: 'https://mcp.example.com', upstream_hosts: ['38.58.57.4'] };
  for (const upstream_allowlist_enabled of [true, false]) {
    const normalized = normalizeSystemSettings({ ...settings, upstream_allowlist_enabled }, true);
    assert.deepEqual(normalized, { ...settings, upstream_allowlist_enabled });
    assert.deepEqual(normalizeSystemSettings(JSON.parse(JSON.stringify(normalized)), true), normalized);
    assert.equal(normalizeSystemSettings({ ...settings, upstream_hosts: [], upstream_allowlist_enabled }, true)?.upstream_allowlist_enabled, upstream_allowlist_enabled);
  }
  for (const upstream_allowlist_enabled of ['false', 'true', 0, 1, null, {}, []]) {
    assert.equal(normalizeSystemSettings({ ...settings, upstream_allowlist_enabled }, true), null);
  }
});

test('initial setup validates browser origin against the actual request host', () => {
  assert.equal(bootstrapOriginAllowed('https://mcp.example.com', 'mcp.example.com', true), true);
  assert.equal(bootstrapOriginAllowed('https://mcp.example.com:8443', 'mcp.example.com:8443', true), true);
  assert.equal(bootstrapOriginAllowed('https://attacker.example.com', 'mcp.example.com', true), false);
  assert.equal(bootstrapOriginAllowed('http://mcp.example.com', 'mcp.example.com', true), false);
  assert.equal(bootstrapOriginAllowed('null', 'mcp.example.com', true), false);
});

test('database setup mode still requires production secrets and dependencies', () => {
  const config = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
  const env = {
    NODE_ENV: 'production', SYSTEM_CONFIG_MODE: 'database', CONFIG_FILE: '/etc/mcp/config.json',
    DATABASE_URL: 'postgres://app:independent@postgres:5432/mcp', REDIS_URL: 'redis://:independent@redis:6379',
    INTERNAL_API_TOKEN: '1'.repeat(64), CREDENTIAL_BROKER_TOKEN: '2'.repeat(64), CREDENTIAL_ENCRYPT_KEY: '3'.repeat(64),
  };
  assert.doesNotThrow(() => validateProductionRuntime(config, 'auth', env));
  assert.doesNotThrow(() => validateProductionRuntime(config, 'gateway', env));
  assert.throws(() => validateProductionRuntime(config, 'auth', { ...env, CREDENTIAL_ENCRYPT_KEY: '' }), /CREDENTIAL_ENCRYPT_KEY/);
  assert.throws(() => validateProductionRuntime(config, 'auth', { ...env, CREDENTIAL_BROKER_TOKEN: env.INTERNAL_API_TOKEN }), /must differ/);
  assert.throws(() => validateProductionRuntime(config, 'auth', { ...env, DATABASE_URL: '' }), /DATABASE_URL/);
});
