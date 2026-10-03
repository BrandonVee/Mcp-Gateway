import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeDraft, mutateAndRefresh, submitDialog } from '../packages/admin-web/src/utils/operations';
import {
  isOAuthUrl,
  isPublicOrigin,
  upstreamHosts,
  validUpstreamHosts,
  validApiKey,
  validationRule,
} from '../packages/admin-web/src/utils/validation';
import { authFields } from '../packages/admin-web/src/features/servers/ServerDialogs';
import { oauthResultKey } from '../packages/admin-web/src/features/connections/oauth-result';
import { routableInstances } from '../packages/admin-web/src/features/servers/upstream-allowlist';
import { apiErrorMessage } from '../packages/admin-web/src/api';
import { normalizeSystemSettings } from '../packages/shared/src/index.js';
import type { McpServer, SystemSettings } from '../packages/admin-web/src/types';

test('successful writes survive refresh failure and are never repeated', async () => {
  let writes = 0;
  const result = await mutateAndRefresh(
    async () => {
      writes++;
      return { saved: true };
    },
    async () => {
      throw new Error('read failed');
    },
  );
  assert.equal(writes, 1);
  assert.deepEqual(result.value, { saved: true });
  assert.equal((result.refreshError as Error).message, 'read failed');
  let reads = 0;
  await assert.rejects(
    mutateAndRefresh(
      async () => {
        throw new Error('write failed');
      },
      async () => {
        reads++;
      },
    ),
    /write failed/,
  );
  assert.equal(reads, 0);
});

test('invalid forms display field errors without submitting or rejecting the click handler', async () => {
  let submits = 0;
  await submitDialog(
    {
      validateFields: async () => {
        throw { errorFields: [{ name: 'username' }] };
      },
    },
    () => {
      submits++;
    },
  );
  assert.equal(submits, 0);
  await submitDialog({ validateFields: async () => ({ username: 'alice' }) }, (values) => {
    assert.equal(values.username, 'alice');
    submits++;
  });
  assert.equal(submits, 1);
});

test('refresh preserves edited settings while updating untouched fields', () => {
  const previous = { public_url: 'https://old.test', upstream_hosts: 'old.test', registration_enabled: true };
  const latest = { ...previous, upstream_hosts: 'old.test\nadded.test', registration_enabled: false };
  const draft = { ...previous, public_url: 'https://draft.test' };
  assert.deepEqual(mergeDraft(previous, latest, draft), { ...latest, public_url: 'https://draft.test' });
  assert.deepEqual(mergeDraft(previous, latest, previous), latest);
});

test('settings origin and host validation match backend restrictions in development and production', () => {
  for (const production of [true, false]) {
    for (const public_url of [
      'https://api.example.test',
      ' https://api.example.test/ ',
      'http://localhost:9001',
      'https://api.example.test/path',
      'https://api.example.test?x=1',
      'https://api.example.test#fragment',
      'https://user:pass@api.example.test',
      'invalid',
    ]) {
      assert.equal(
        isPublicOrigin(public_url, production),
        Boolean(normalizeSystemSettings({ public_url, upstream_hosts: [] }, production)),
        public_url,
      );
    }
  }
  assert.deepEqual(upstreamHosts(' API.example.test,\napi.example.test mcp-a'), ['api.example.test', 'mcp-a']);
  for (const hosts of [
    '',
    'mcp-a\n192.168.1.1',
    'https://api.example.test',
    'api.example.test:443',
    'api..example.test',
    'a'.repeat(254),
  ]) {
    assert.equal(
      validUpstreamHosts(hosts),
      Boolean(
        normalizeSystemSettings({ public_url: 'https://example.test', upstream_hosts: upstreamHosts(hosts) }, true),
      ),
      hosts,
    );
  }
  assert.equal(validUpstreamHosts(Array.from({ length: 201 }, (_, i) => `host-${i}`).join('\n')), false);
});

test('OAuth validation permits HTTPS and local HTTP and validates optional blanks', async () => {
  for (const value of [
    'https://provider.example/authorize',
    'http://localhost:9001/token',
    'http://127.0.0.1:9001/token',
  ])
    assert.equal(isOAuthUrl(value), true);
  for (const value of [
    'http://provider.example/token',
    'https://user:pass@provider.example/token',
    'https://provider.example/token#fragment',
  ])
    assert.equal(isOAuthUrl(value), false);
  const optional = validationRule(isOAuthUrl, 'invalid', true);
  for (const value of ['', null, undefined]) await optional.validator({}, value);
  await assert.rejects(optional.validator({}, 'http://provider.example/token'), /invalid/);
});

test('editing OAuth without optional values preserves blank fields and public clients omit retained input secrets', () => {
  const values = {
    name: 'oauth',
    signup_access: false,
    url: 'https://upstream.test/mcp',
    auth_mode: 'oauth' as const,
    oauth_scopes: null,
    oauth_resource: null,
    oauth_issuer: null,
    oauth_client_secret: 'retained-form-input',
    oauth_client_auth_method: 'none' as const,
  };
  const body = authFields(values);
  assert.equal(body.oauth_scopes, '');
  assert.equal(body.oauth_resource, '');
  assert.equal(body.oauth_issuer, '');
  assert.equal(body.oauth_client_secret, undefined);
  assert.equal(
    authFields({ ...values, oauth_client_auth_method: 'client_secret_basic', oauth_client_secret: '' })
      .oauth_client_secret,
    undefined,
  );
});

test('API key validation rejects blank, oversized and multiline credentials', () => {
  assert.equal(validApiKey('valid-key'), true);
  assert.equal(validApiKey('a'.repeat(4096)), true);
  for (const value of ['', '   ', 'a'.repeat(4097), 'key\nvalue', 'key\rvalue', 'key\u0000value'])
    assert.equal(validApiKey(value), false);
});

test('route counts exclude paused services, disabled instances and hosts blocked by the allowlist', () => {
  const settings = {
    upstream_allowlist_enabled: true,
    upstream_hosts: ['trusted.test'],
    public_url: 'https://gateway.test',
  } as SystemSettings;
  const server = {
    enabled: true,
    instances: [
      { id: 'trusted', enabled: true, url: 'https://trusted.test/mcp' },
      { id: 'blocked', enabled: true, url: 'https://other.test/mcp' },
      { id: 'disabled', enabled: false, url: 'https://trusted.test/mcp' },
    ],
  } as McpServer;
  assert.deepEqual(
    routableInstances(server, settings).map((instance) => instance.id),
    ['trusted'],
  );
  assert.equal(routableInstances({ ...server, enabled: false }, settings).length, 0);
  assert.equal(routableInstances(server, { ...settings, upstream_allowlist_enabled: false }).length, 2);
  assert.equal(routableInstances(server, { ...settings, upstream_hosts: [] }).length, 0);
});

test('business errors and OAuth callback failures provide actionable localized explanations', () => {
  for (const error of [
    'instance_already_exists',
    'invalid_api_key',
    'oauth_not_configured',
    'server_changed_or_denied',
    'api_key_header must be authorization or an x-* header',
    'oauth_client_secret is required',
  ]) {
    assert.notEqual(apiErrorMessage(400, { error }, 'zh-CN'), apiErrorMessage(400, {}, 'zh-CN'));
    assert.notEqual(apiErrorMessage(400, { error }, 'en-US'), apiErrorMessage(400, {}, 'en-US'));
  }
  assert.match(apiErrorMessage(400, { error: 'unknown_server', server: 'deleted' }, 'zh-CN'), /deleted.*重新选择/);
  for (const result of [
    'cancelled',
    'invalid_state',
    'session_expired',
    'unavailable',
    'issuer_mismatch',
    'token_error',
  ])
    assert.notEqual(oauthResultKey(result), 'connections.oauthUnknownError');
  assert.equal(oauthResultKey('unexpected-provider-secret'), 'connections.oauthUnknownError');
  for (const result of ['constructor', '__proto__', 'toString']) {
    assert.equal(oauthResultKey(result), 'connections.oauthUnknownError');
    assert.equal(apiErrorMessage(400, { error: result }, 'zh-CN'), apiErrorMessage(400, {}, 'zh-CN'));
  }
});
