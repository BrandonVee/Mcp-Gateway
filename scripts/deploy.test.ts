import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { readDeploymentEnvironment } from './deploy-env.js';

const script = resolve('scripts/deploy.sh');
const environmentKeys = [
  'MCP_DEPLOY_DIR',
  'MCP_HTTP_PORT',
  'MCP_IMAGE_PREFIX',
  'MCP_IMAGE_NAME',
  'MCP_VERSION',
  'COMPOSE_PROJECT_NAME',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'INTERNAL_API_TOKEN',
  'CREDENTIAL_BROKER_TOKEN',
  'CREDENTIAL_ENCRYPT_KEY',
  'ADMIN_PASSWORD',
  'AUTH_TRUSTED_PROXY_IPS',
  'MCP_UPDATE_ENABLED',
  'DOCKER_SOCKET',
  'DOCKER_GID',
];

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-installer-test-'));
  const deployment = join(directory, 'deployment');
  const log = join(directory, 'docker.log');
  // No containers are created. Record whether the installer selects build or pull.
  writeFileSync(
    join(directory, 'docker'),
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$MOCK_DOCKER_LOG"',
      'if [[ "$1" == network ]]; then echo "172.88.0.0/24,"; fi',
      'if [[ "$*" == *"build mcp-server"* && ${MOCK_BUILD_FAIL:-0} == 1 ]]; then exit 42; fi',
      'if [[ "$1" == ps && ${MOCK_LEGACY_APPS:-0} == 1 ]]; then',
      '  for service in auth gateway admin-web app; do if [[ "$*" == *"service=$service"* ]]; then echo "legacy-$service"; fi; done',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o700 },
  );
  writeFileSync(
    join(directory, 'stat'),
    '#!/usr/bin/env bash\nif [[ "$1" == -c && "$2" == %g ]]; then echo "${MOCK_SOCKET_GID:-999}"; else /usr/bin/stat "$@"; fi\n',
    { mode: 0o700 },
  );
  writeFileSync(join(directory, 'getent'), '#!/usr/bin/env bash\necho "docker:x:998:"\n', { mode: 0o700 });
  const env = { ...process.env };
  for (const key of environmentKeys) delete env[key];
  Object.assign(env, {
    PATH: directory + delimiter + process.env.PATH,
    MOCK_DOCKER_LOG: log,
    MCP_DEPLOY_DIR: deployment,
    COMPOSE_PROJECT_NAME: 'mcp-installer-test',
    // These tests cover other installer options; web-update defaults are exercised below.
    MCP_UPDATE_ENABLED: 'false',
  });
  return {
    deployment,
    envFile: join(deployment, 'runtime.env'),
    run: (args: string[], input = '', extra: Record<string, string> = {}) =>
      spawnSync('bash', [script, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 5000 }),
    commands: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function updateSandbox() {
  const setup = sandbox();
  // Keep Unix socket paths short enough for both macOS and Linux.
  const directory = mkdtempSync('/tmp/mcp-update-socket-test-');
  const socketPath = join(directory, 'docker.sock');
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(socketPath, done);
  });
  return {
    ...setup,
    updateEnv: { MCP_UPDATE_ENABLED: '', DOCKER_SOCKET: socketPath },
    cleanup: async () => {
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
      rmSync(directory, { recursive: true, force: true });
      setup.cleanup();
    },
  };
}

test('web updates are enabled by default with the socket overlay, group and persistent log', async () => {
  const setup = await updateSandbox();
  try {
    const result = setup.run(['--yes'], '', setup.updateEnv);
    assert.equal(result.status, 0, result.stderr);
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_UPDATE_ENABLED, 'true');
    assert.equal(saved.DOCKER_SOCKET, setup.updateEnv.DOCKER_SOCKET);
    assert.equal(saved.DOCKER_GID, '999');
    assert.ok(existsSync(join(setup.deployment, 'update.log')));
    assert.match(setup.commands(), /-f .*compose\.self-update\.yml .*up -d --no-build/);
    assert.equal(setup.run(['--yes', '--prepare-only'], '', setup.updateEnv).status, 0);
    assert.deepEqual(readDeploymentEnvironment(setup.envFile), saved);
  } finally {
    await setup.cleanup();
  }
});

test('explicitly disabling web updates persists without a socket and can be reversed', async () => {
  const setup = await updateSandbox();
  try {
    const disabled = { MCP_UPDATE_ENABLED: 'false', DOCKER_SOCKET: '/missing/docker.sock' };
    const result = setup.run(['--yes'], '', disabled);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readDeploymentEnvironment(setup.envFile).MCP_UPDATE_ENABLED, 'false');
    assert.ok(!setup.commands().includes('compose.self-update.yml'));
    assert.ok(!existsSync(join(setup.deployment, 'update.log')));
    assert.equal(setup.run(['--yes'], '', { MCP_UPDATE_ENABLED: '', DOCKER_SOCKET: '' }).status, 0);
    assert.equal(readDeploymentEnvironment(setup.envFile).MCP_UPDATE_ENABLED, 'false');
    assert.ok(!setup.commands().includes('compose.self-update.yml'));
    assert.equal(setup.run(['--yes'], '', { ...setup.updateEnv, MCP_UPDATE_ENABLED: 'true' }).status, 0);
    assert.equal(readDeploymentEnvironment(setup.envFile).MCP_UPDATE_ENABLED, 'true');
    assert.match(setup.commands(), /compose\.self-update\.yml/);
  } finally {
    await setup.cleanup();
  }
});

test('default web updates report a missing socket or invalid flag before saving configuration', () => {
  const setup = sandbox();
  try {
    const missing = setup.run(['--yes'], '', { MCP_UPDATE_ENABLED: '', DOCKER_SOCKET: '/missing/docker.sock' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /未找到 Docker socket/);
    assert.equal(existsSync(setup.envFile), false);
    const invalid = setup.run(['--yes'], '', { MCP_UPDATE_ENABLED: 'invalid' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /MCP_UPDATE_ENABLED 须为 true 或 false/);
    assert.equal(existsSync(setup.envFile), false);
    assert.ok(!setup.commands().includes(' up '));
  } finally {
    setup.cleanup();
  }
});

test('default web updates resolve the docker group when the socket group is root', async () => {
  const setup = await updateSandbox();
  try {
    const result = setup.run(['--yes', '--prepare-only'], '', { ...setup.updateEnv, MOCK_SOCKET_GID: '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readDeploymentEnvironment(setup.envFile).DOCKER_GID, '998');
  } finally {
    await setup.cleanup();
  }
});

test('interactive setup validates input and preserves a literal hidden password on repeat deployment', () => {
  const setup = sandbox();
  try {
    const password = 'A long-$HOME-$(never_execute)-"quoted"\\secret\'=literal 密码';
    const result = setup.run(
      ['--prepare-only', '--interactive'],
      ['invalid', '0', '18081', '3', '1', 'short', password, 'different-password', password, password, 'y', ''].join(
        '\n',
      ),
    );
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
    const config = JSON.parse(readFileSync(join(setup.deployment, 'config.json'), 'utf8'));
    assert.equal(new URL(config.gateway.registryUrl).hostname, '127.0.0.1');
    assert.equal(setup.run(['--yes', '--prepare-only']).status, 0);
    assert.deepEqual(readDeploymentEnvironment(setup.envFile), saved);
    assert.ok(!setup.commands().includes(' up '));
  } finally {
    setup.cleanup();
  }
});

test('interactive image deployment selects the tag without asking for the repository', () => {
  const setup = sandbox();
  try {
    const password = 'known-installer-test-password';
    const result = setup.run(['--interactive'], ['18082', '2', 'invalid/tag', 'v1.2.3', 'y', ''].join('\n'), {
      ADMIN_PASSWORD: password,
      MCP_IMAGE_PREFIX: 'ghcr.io/example/',
      MCP_IMAGE_NAME: 'mcp-app',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes('镜像仓库前缀') && !result.stderr.includes('镜像名称'));
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_IMAGE_PREFIX, 'ghcr.io/example/');
    assert.equal(saved.MCP_IMAGE_NAME, 'mcp-app');
    assert.equal(saved.MCP_VERSION, 'v1.2.3');
    assert.equal(saved.AUTH_TRUSTED_PROXY_IPS, '172.88.0.0/24');
    assert.match(setup.commands(), /pull mcp-server/);
    assert.ok(!setup.commands().includes('build mcp-server'));
    assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
  } finally {
    setup.cleanup();
  }
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
  } finally {
    setup.cleanup();
  }
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
    assert.equal(saved.MCP_IMAGE_PREFIX, 'brandonvee/');
    assert.equal(saved.MCP_IMAGE_NAME, 'mcp-gateway');
    assert.equal(saved.MCP_VERSION, 'latest');
    assert.match(saved.ADMIN_PASSWORD, /^[a-f0-9]{64}$/);
    assert.equal(setup.run(['--prepare-only']).status, 0);
    assert.deepEqual(readDeploymentEnvironment(setup.envFile), saved);
    assert.ok(!first.stderr.includes('HTTP 端口'));
  } finally {
    setup.cleanup();
  }
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
  } finally {
    setup.cleanup();
  }
});

test('upgrade prepares the app image before replacing legacy containers and preserves data services', () => {
  const setup = sandbox();
  try {
    const extra = { ADMIN_PASSWORD: 'known-installer-test-password', MOCK_LEGACY_APPS: '1', MCP_IMAGE_PREFIX: '' };
    assert.equal(setup.run(['--yes'], '', extra).status, 0);
    const commands = setup.commands();
    assert.ok(commands.indexOf('build mcp-server') < commands.indexOf('stop --time 15 legacy-auth'));
    assert.ok(commands.indexOf('rm legacy-auth') < commands.indexOf('up -d --no-build'));
    assert.match(commands, /stop --time 15 legacy-auth legacy-gateway legacy-admin-web legacy-app/);
    assert.ok(!commands.includes('down') && !commands.includes('stop postgres'));
  } finally {
    setup.cleanup();
  }
  const failed = sandbox();
  try {
    const result = failed.run(['--yes'], '', {
      ADMIN_PASSWORD: 'known-installer-test-password',
      MOCK_LEGACY_APPS: '1',
      MOCK_BUILD_FAIL: '1',
      MCP_IMAGE_PREFIX: '',
    });
    assert.equal(result.status, 42);
    assert.ok(!failed.commands().includes('stop --time'));
  } finally {
    failed.cleanup();
  }
});

test('local image deployment skips build/pull and uses the imported tag', () => {
  const setup = sandbox();
  try {
    const result = setup.run(['--yes', '--use-local-image'], '', {
      ADMIN_PASSWORD: 'known-installer-test-password',
      MCP_VERSION: 'local',
      MCP_IMAGE_PREFIX: 'ghcr.io/previous/',
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_VERSION, 'local');
    assert.equal(saved.MCP_IMAGE_PREFIX, '');
    assert.match(setup.commands(), /image inspect mcp-gateway:local/);
    assert.ok(!setup.commands().includes('build mcp-server') && !setup.commands().includes('pull mcp-server'));
    assert.match(setup.commands(), /up -d --no-build --pull never --wait/);
  } finally {
    setup.cleanup();
  }
});

test('published repository is the default and persists across upgrades and imported images', () => {
  const setup = sandbox();
  try {
    const result = setup.run(['--interactive'], ['18082', '2', 'latest', 'y', ''].join('\n'), {
      ADMIN_PASSWORD: 'known-installer-test-password',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes('镜像仓库前缀') && !result.stderr.includes('镜像名称'));
    assert.match(result.stderr, /brandonvee\/mcp-gateway:latest/);
    const saved = readDeploymentEnvironment(setup.envFile);
    assert.equal(saved.MCP_IMAGE_PREFIX, 'brandonvee/');
    assert.equal(saved.MCP_IMAGE_NAME, 'mcp-gateway');
    assert.equal(saved.MCP_VERSION, 'latest');
    assert.equal(setup.run(['--yes', '--prepare-only']).status, 0);
    assert.deepEqual(readDeploymentEnvironment(setup.envFile), saved);
    assert.equal(setup.run(['--yes', '--use-local-image']).status, 0);
    assert.match(setup.commands(), /image inspect mcp-gateway:latest/);
  } finally {
    setup.cleanup();
  }
  const invalid = sandbox();
  try {
    assert.equal(invalid.run(['--yes', '--prepare-only'], '', { MCP_IMAGE_NAME: 'Invalid/Name' }).status, 1);
    assert.equal(existsSync(invalid.deployment), false);
  } finally {
    invalid.cleanup();
  }
});

test('pulled deployments follow the newest release unless MCP_VERSION pins one', () => {
  const setup = sandbox();
  try {
    const extra = { ADMIN_PASSWORD: 'known-installer-test-password' };
    const pinned = setup.run(['--interactive'], ['18086', '2', 'v0.2.0', 'y', ''].join('\n'), extra);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(readDeploymentEnvironment(setup.envFile).MCP_VERSION, 'v0.2.0');
    assert.equal(setup.run(['--yes', '--prepare-only'], '', extra).status, 0);
    assert.equal(
      readDeploymentEnvironment(setup.envFile).MCP_VERSION,
      'latest',
      'a rerun upgrades instead of reusing the saved tag',
    );
    const repinned = setup.run(['--yes', '--prepare-only'], '', { ...extra, MCP_VERSION: 'v0.2.0' });
    assert.equal(repinned.status, 0, repinned.stderr);
    assert.equal(readDeploymentEnvironment(setup.envFile).MCP_VERSION, 'v0.2.0');
  } finally {
    setup.cleanup();
  }
});
