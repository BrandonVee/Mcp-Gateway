import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidRedirectUri } from '../packages/auth-server/src/oauth-redirect.js';

test('public OAuth redirect validation accepts only intended native and web callbacks', () => {
  assert.equal(isValidRedirectUri('workbuddy://workbuddy/mcp/connector%3Amy-server/oauth/callback'), true);
  assert.equal(isValidRedirectUri('http://127.0.0.1:37281/oauth/callback'), true);
  assert.equal(isValidRedirectUri('https://client.example.test/callback'), true);
  assert.equal(isValidRedirectUri('workbuddy://other/mcp/connector%3Amy-server/oauth/callback'), false);
  assert.equal(isValidRedirectUri('workbuddy://workbuddy/mcp/connector%3Amy-server/oauth/callback?next=evil'), false);
  assert.equal(isValidRedirectUri('http://client.example.test/callback'), false);
  assert.equal(isValidRedirectUri('https://user:pass@client.example.test/callback'), false);
});
