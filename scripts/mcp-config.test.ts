import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpConfig, mcpServerUrl } from '../packages/admin-web/src/features/connections/mcp-config.js';
import type { ConnectionServer } from '../packages/admin-web/src/types.js';

const server = (name: string): ConnectionServer => ({ name, display_name: name, auth_mode: 'none', connection_status: 'not_required' });

test('copying one service returns only entries inside mcpServers with the Gateway URL', () => {
  const copied = JSON.parse(mcpConfig([server('hscode')], 'http://localhost:8000'));
  assert.deepEqual(copied, { hscode: { type: 'streamableHttp', url: 'http://localhost:8000/mcp/hscode' } });
  assert.equal(copied.mcpServers, undefined);
});

test('copying all services preserves the selected entries and encodes service names', () => {
  const copied = JSON.parse(mcpConfig([server('hscode'), server('知识库')], 'https://mcp.example.test/'));
  assert.deepEqual(Object.keys(copied), ['hscode', '知识库']);
  assert.equal(copied.hscode.url, 'https://mcp.example.test/mcp/hscode');
  assert.equal(copied['知识库'].url, 'https://mcp.example.test/mcp/%E7%9F%A5%E8%AF%86%E5%BA%93');
  for (const entry of Object.values(copied)) assert.deepEqual(Object.keys(entry as object).sort(), ['type', 'url']);
  for (const resource of ['file:///tmp/config', 'https://user:secret@mcp.example.test']) {
    assert.throws(() => mcpConfig([server('hscode')], resource));
  }
});

test('displayed MCP URLs match copied entries and reject dot-segment service names', () => {
  const resource = 'https://mcp.example.test/';
  const name = 'full-service.name_v2';
  const copied = JSON.parse(mcpConfig([server(name)], resource));
  assert.equal(mcpServerUrl(name, resource), copied[name].url);
  assert.equal(copied[name].url, 'https://mcp.example.test/mcp/full-service.name_v2');
  for (const invalid of ['', '.', '..']) assert.throws(() => mcpServerUrl(invalid, resource));
});
