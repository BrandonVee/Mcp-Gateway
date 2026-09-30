import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { test } from 'node:test';
import { readDeploymentEnvironment } from './deploy-env.js';

const script = resolve('scripts/deploy.sh');
const environmentKeys = ['MCP_DEPLOY_DIR', 'MCP_HTTP_PORT', 'MCP_IMAGE_PREFIX', 'MCP_VERSION', 'COMPOSE_PROJECT_NAME',
  'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'INTERNAL_API_TOKEN', 'CREDENTIAL_BROKER_TOKEN',
  'CREDENTIAL_ENCRYPT_KEY', 'ADMIN_PASSWORD', 'AUTH_TRUSTED_PROXY_IPS'];

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-installer-test-'));
  const deployment = join(directory, 'deployment');
  const log = join(directory, 'docker.log');
  // No containers are created. Record whether the installer selects build or pull.
  writeFileSync(join(directory, 'docker'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$MOCK_DOCKER_LOG"',
    'if [[ "$1" == network ]]; then echo "172.88.0.0/24,"; fi',
    'exit 0',
  ].join('\n'), { mode: 0o700 });
  const env = { ...process.env };
  for (const key of environmentKeys) delete env[key];
  Object.assign(env, { PATH: directory + delimiter + process.env.PATH,
    MOCK_DOCKER_LOG: log, MCP_DEPLOY_DIR: deployment, COMPOSE_PROJECT_NAME: 'mcp-installer-test' });
  return {
    deployment,
    envFile: join(deployment, 'runtime.env'),
    run: (args: string[], input = '', extra: Record<string, string> = {}) =>
      spawnSync('bash', [script, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 5000 }),
    commands: () => existsSync(log) ? readFileSync(log, 'utf8') : '',
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('interactive setup validates input and preserves a literal hidden password on repeat deployment', () => {
  const setup = sandbox();
  try {
    const password = 'A long-$HOME-$(never_execute)-"quoted"\\secret\'=literal 密码';
    const result = setup.run(['--prepare-only', '--interactive'], [
      'invalid', '0', '18081', '3', '1', 'short', password, 'different-password',
      password, password, 'y', '',
    ].join('\n'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /端口须为/);
    assert.match(result.stderr, /两次密码不一致/);
    assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_HTTP_PORT, '18081');
    assert.equal(saved.MCP_IMAGE_PREFIX, '');
    assert.equal(saved.ADMIN_PASSWORD, password);
    assert.equal(statSync(setup.envFile).mode & 0o777, 0o600);
    assert.equal(saved.PUBLIC_URL, undefined);
    assert.equal(setup.run(['--yes', '--prepare-only']).status, 0);
    assert.deepEqual(readDeploymentEnvironment(setup.envFile), saved);
    assert.ok(!setup.commands().includes(' up '));
  } finally { setup.cleanup(); }
});

test('interactive image deployment selects the repository and tag without printing the supplied password', () => {
  const setup = sandbox();
  try {
    const password = 'known-installer-test-password';
    const result = setup.run(['--interactive'], ['18082', '2', 'ghcr.io/example',
      'invalid/tag', 'v1.2.3', 'y', ''].join('\n'), { ADMIN_PASSWORD: password });
    assert.equal(result.status, 0, result.stderr);
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_IMAGE_PREFIX, 'ghcr.io/example/');
    assert.equal(saved.MCP_VERSION, 'v1.2.3');
    assert.equal(saved.AUTH_TRUSTED_PROXY_IPS, '172.88.0.0/24');
    assert.match(setup.commands(), /pull auth gateway admin-web/);
    assert.ok(!setup.commands().includes('build auth'));
    assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
  } finally { setup.cleanup(); }
});

test('cancelling installation or an upgrade leaves saved configuration untouched', () => {
  const setup = sandbox();
  try {
    const extra = { ADMIN_PASSWORD: 'known-installer-test-password' };
    assert.equal(setup.run(['--interactive'], ['18083', '1', 'n', ''].join('\n'), extra).status, 0);
    assert.equal(existsSync(setup.deployment), false);
    assert.equal(setup.run(['--yes', '--prepare-only'], '', extra).status, 0);
    const saved = readFileSync(setup.envFile, 'utf8');
    const result = setup.run(['--interactive'], ['18084', '1', 'n', ''].join('\n'));
    assert.equal(result.status, 0);
    assert.equal(readFileSync(setup.envFile, 'utf8'), saved);
    assert.ok(!result.stderr.includes('首次管理员密码'));
    assert.ok(!setup.commands().includes(' up '));
  } finally { setup.cleanup(); }
});

test('noninteractive deployment keeps defaults and existing credentials and rejects invalid settings before writing', () => {
  const setup = sandbox();
  try {
    assert.equal(setup.run(['--yes', '--interactive']).status, 1);
    assert.equal(setup.run(['--yes', '--prepare-only'], '', { MCP_HTTP_PORT: '65536' }).status, 1);
    assert.equal(setup.run(['--yes', '--prepare-only'], '', { ADMIN_PASSWORD: 'short' }).status, 1);
    assert.equal(existsSync(setup.deployment), false);
    const first = setup.run(['--yes', '--prepare-only']);
    assert.equal(first.status, 0);
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_HTTP_PORT, '8080');
    assert.match(saved.ADMIN_PASSWORD, /^[a-f0-9]{64}$/);
    assert.equal(setup.run(['--prepare-only']).status, 0);
    assert.deepEqual(readDeploymentEnvironment(setup.envFile), saved);
    assert.ok(!first.stderr.includes('HTTP 端口'));
  } finally { setup.cleanup(); }
});

test('exhausted interactive input aborts without saving, while help has no side effects', () => {
  const setup = sandbox();
  try {
    const exhausted = setup.run(['--interactive'], '');
    assert.equal(exhausted.status, 1);
    assert.match(exhausted.stderr, /输入已结束/);
    assert.equal(existsSync(setup.deployment), false);
    assert.equal(setup.run(['--help']).status, 0);
    assert.equal(existsSync(setup.deployment), false);
  } finally { setup.cleanup(); }
});
