import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointUrlRule } from '../packages/admin-web/src/features/servers/ServerDialogs';
import { untrustedUpstreamHost } from '../packages/admin-web/src/features/servers/upstream-allowlist';
import type { SystemSettings } from '../packages/admin-web/src/types';

const validate = async (value: string) => {
  try {
    await endpointUrlRule('invalid')['validator']({}, value);
    return true;
  } catch {
    return false;
  }
};

test('upstream endpoints accept container and internal hostnames', async () => {
  // antd's url rule rejects these because the hostname has no dot.
  assert.equal(await validate('http://fx-app-1:8765/mcp/fx'), true);
  assert.equal(await validate('http://mcp-a:3001/mcp'), true);
  assert.equal(await validate('https://mcp.example.com/mcp'), true);
  assert.equal(await validate('http://192.168.1.10:8765/mcp'), true);
});

test('upstream endpoints still reject anything that is not an absolute http(s) URL', async () => {
  assert.equal(await validate(''), false);
  assert.equal(await validate('fx-app-1:8765/mcp'), false);
  assert.equal(await validate('ftp://mcp.example/mcp'), false);
  assert.equal(await validate('javascript:alert(1)'), false);
  assert.equal(await validate('http://user:pass@fx-app-1:8765/mcp'), false);
  assert.equal(await validate('https://mcp.example/mcp#fragment'), false);
});

test('quick-add identifies only valid untrusted upstream hosts while the allowlist is enabled', () => {
  const settings: SystemSettings = {
    managed: true,
    configured: true,
    public_url: 'https://gateway.example.com',
    upstream_allowlist_enabled: true,
    upstream_hosts: ['trusted.example.com'],
  };
  assert.equal(untrustedUpstreamHost('http://MCP-A:8765/mcp/fx', settings), 'mcp-a');
  assert.equal(untrustedUpstreamHost('https://trusted.example.com:8443/mcp', settings), null);
  assert.equal(untrustedUpstreamHost('http://192.168.1.10:8765/mcp', settings), '192.168.1.10');
  assert.equal(untrustedUpstreamHost('http://mcp-a:8765/mcp', { ...settings, upstream_hosts: [] }), 'mcp-a');
  assert.equal(
    untrustedUpstreamHost('http://mcp-a:8765/mcp', { ...settings, upstream_allowlist_enabled: false }),
    null,
  );
  assert.equal(untrustedUpstreamHost('http://mcp-a:8765/mcp', null), null);
  for (const value of [
    undefined,
    'invalid',
    'file:///etc/passwd',
    'https://user:secret@other.example/mcp',
    'https://other.example/mcp#fragment',
    'https://gateway.example.com',
    'https://gateway.example.com/mcp/service',
  ])
    assert.equal(untrustedUpstreamHost(value, settings), null);
});
