import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointUrlRule } from '../packages/admin-web/src/features/servers/ServerDialogs';

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
});
