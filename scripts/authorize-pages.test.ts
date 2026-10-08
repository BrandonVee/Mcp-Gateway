import { applySystemSettings, currentSystemSettings, normalizeSystemSettings } from '../packages/shared/src/index.js';
import { hashSignupCode, matchesSignupCode } from '../packages/auth-server/src/registration.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizationLink,
  authorizationParams,
  consentPage,
  loginPage,
  pageLanguage,
  signupPage,
} from '../packages/auth-server/src/authorize-pages.js';
import { validateSignup } from '../packages/auth-server/src/registration.js';

const q = {
  response_type: 'code',
  client_id: 'test-client',
  redirect_uri: 'http://127.0.0.1:55945/oauth/callback',
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'S256',
  state: 'original-state',
  scope: 'mcp',
  resource: 'https://mcp.example.test/mcp/hscode',
};
const details = { clientName: 'WorkBuddy', resourceName: 'HS Code' };

test('switching between login, signup, and languages preserves all authorization parameters', () => {
  for (const path of ['/authorize', '/authorize/signup'] as const) {
    const url = new URL(
      authorizationLink(path, { ...q, password: 'must-not-leak', form_token: 'secret' }, 'zh-CN'),
      'https://mcp.example.test',
    );
    assert.equal(url.pathname, path);
    for (const [key, value] of Object.entries(q)) assert.equal(url.searchParams.get(key), value);
    assert.equal(url.searchParams.get('lang'), 'zh-CN');
    assert.equal(url.searchParams.has('password'), false);
    assert.equal(url.searchParams.has('form_token'), false);
  }
  assert.deepEqual(authorizationParams({ ...q, username: 'alice', state: ['malicious'] }), { ...q, state: '' });
});

test('all authorization pages escape untrusted input and preserve hidden PKCE fields', () => {
  const injection = '"><img src=x onerror=alert(1)>';
  const injectedQ = { ...q, state: injection };
  const injectedDetails = { clientName: injection, resourceName: injection };
  for (const html of [
    loginPage(injectedQ, 'zh-CN', injectedDetails, 'invalidCredentials', injection),
    signupPage(injectedQ, 'zh-CN', injectedDetails, 'csrf-token', 'passwordMismatch', injection),
    consentPage(injectedQ, injection, 'zh-CN', injectedDetails, true, true),
  ]) {
    assert.ok(html.includes('name="state" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'));
    assert.ok(html.includes(`name="code_challenge" value="${q.code_challenge}"`));
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script'), false);
    assert.ok(html.includes('name="viewport"'));
  }
});

test('signup errors are localized, preserve only username, and explain restricted service access', () => {
  const html = signupPage(q, 'zh-CN', details, 'test-token', 'passwordMismatch', 'alice');
  assert.ok(html.includes('两次输入的密码不一致'));
  assert.ok(html.includes('value="alice"'));
  assert.ok(html.includes('autocomplete="new-password"'));
  assert.doesNotMatch(html, /type="password"[^>]*value=/);
  assert.ok(consentPage(q, 'alice', 'zh-CN', details, true, true).includes('需要管理员开通访问权限'));
  assert.ok(loginPage(q, 'en-US', details).includes('Create an account'));
  assert.equal(pageLanguage(undefined, 'en-US;q=0.2,zh-CN;q=0.9'), 'zh-CN');
  assert.equal(pageLanguage('en-US', 'zh-CN'), 'en-US');
});

test('self-registration uses email as identity and validates password length and confirmation', () => {
  assert.equal(validateSignup('alice', 'alice@example.com', 'a-safe-password', 'a-safe-password'), null);
  for (const name of ['', '*', 'a', 'a'.repeat(65), 'alice@example.com', '<script>']) {
    assert.equal(validateSignup(name, 'alice@example.com', 'a-safe-password', 'a-safe-password'), null);
  }
  for (const email of ['', 'alice', 'alice@', 'a@b', 'alice @example.com']) {
    assert.equal(validateSignup('alice', email, 'a-safe-password', 'a-safe-password'), 'invalidEmail');
  }
  assert.equal(validateSignup('alice', 'alice@example.com', 'short', 'short'), 'invalidPassword');
  assert.equal(validateSignup('alice', 'alice@example.com', 'x'.repeat(257), 'x'.repeat(257)), 'invalidPassword');
  assert.equal(validateSignup('alice', 'alice@example.com', 'a-safe-password', 'another-password'), 'passwordMismatch');
});

test('registration email verification setting controls the OAuth signup fields', () => {
  const saved = currentSystemSettings();
  try {
    applySystemSettings({ ...saved, registration_email_verification: false });
    const withoutCode = signupPage(q, 'zh-CN', details, 'csrf', undefined, '', 'alice@example.com');
    assert.ok(!withoutCode.includes('name="verification_code"'));
    assert.ok(!withoutCode.includes('name="username"'));
    applySystemSettings({ ...saved, registration_email_verification: true });
    const withCode = signupPage(q, 'zh-CN', details, 'csrf', 'verificationSent', '', 'alice@example.com');
    assert.ok(withCode.includes('name="verification_code"'));
    assert.ok(withCode.includes('value="send-code" formnovalidate'));
    assert.ok(withCode.includes('name="form_token"'));
    assert.ok(withCode.includes('name="code_challenge"'));
    assert.ok(withCode.includes('验证码已发送'));
  } finally {
    applySystemSettings(saved);
  }
  const settings = { public_url: 'https://mcp.example.test', upstream_hosts: [] };
  assert.equal(
    normalizeSystemSettings({ ...settings, registration_email_verification: true })?.registration_email_verification,
    true,
  );
  assert.equal(normalizeSystemSettings({ ...settings, registration_email_verification: 'true' }), null);
});
test('signup codes are hashed and malformed values never verify', () => {
  const hash = hashSignupCode('012345');
  assert.equal(hash.length, 64);
  assert.notEqual(hash, '012345');
  assert.equal(matchesSignupCode('012345', hash), true);
  for (const value of ['', '12345', '1234567', '000000', '<script>'])
    assert.equal(matchesSignupCode(value, hash), false);
  assert.equal(matchesSignupCode('012345', 'bad hash'), false);
});
