/** Fresh image, authenticated setup, actual dependency permissions and persisted restart. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const project = 'mcp-web-setup-ci';
const compose = ['compose', '-p', project, '-f', '.github/compose.setup-ci.yml'];
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const base = `http://127.0.0.1:${process.env.SETUP_TEST_PORT || 18081}`;
const input = {
  postgres: { host: 'postgres', port: 5432, username: 'mcp', password: 'setup:pg@password/#12345', database: 'mcp' },
  redis: { host: 'redis', port: 6379, password: 'setup:redis@password/#12345', database: 0 },
  adminUsername: 'setup-admin', adminPassword: 'browser-setup-admin-password-123456',
};
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) { try { if (await check()) return; } catch {} await new Promise(done => setTimeout(done, 500)); }
  throw new Error('Application did not become ready');
}
async function main() {
  try {
    docker([...compose, 'up', '-d', '--wait']);
    assert.equal((await (await fetch(base + '/healthz')).json()).mode, 'setup');
    const token = docker([...compose, 'exec', '-T', 'mcp-server', 'cat', '/app/data/setup-token']);
    const post = (path: string, body: object = input, secret = token, origin = base) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': secret, origin }, body: JSON.stringify(body) });
    assert.equal((await post('/setup/verify', {}, 'bad')).status, 401);
    assert.equal((await post('/setup/verify', {})).status, 200);
    assert.equal((await post('/setup/test', input, token, 'https://evil.example')).status, 403);
    assert.equal((await post('/setup/test-postgres', { postgres: { ...input.postgres, password: 'wrong' } })).status, 422);
    docker([...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-c', "CREATE ROLE limited LOGIN PASSWORD 'limited-ci-password'; GRANT CONNECT ON DATABASE mcp TO limited;"]);
    assert.equal((await post('/setup/test-postgres', { postgres: { ...input.postgres, username: 'limited', password: 'limited-ci-password' } })).status, 422);
    assert.equal((await post('/setup/test-redis', { redis: { ...input.redis, password: 'wrong' } })).status, 422);
    assert.equal((await post('/setup/test-postgres', { postgres: input.postgres })).status, 200);
    assert.equal((await post('/setup/test-redis', { redis: input.redis })).status, 200);
    assert.equal((await post('/setup/install')).status, 201);
    await waitFor(async () => (await (await fetch(base + '/healthz')).json()).auth === true);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/gateway/health')).status, 200);
    assert.equal((await post('/setup/install')).status, 405);
    assert.equal(docker([...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-Atc', "SELECT username FROM users WHERE role='admin'"]), input.adminUsername);
    assert.equal(docker([...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-Atc', "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'mcp_setup_%'"]), '0');
    const before = docker([...compose, 'exec', '-T', 'mcp-server', 'cat', '/app/data/bootstrap.json']);
    assert.equal(docker([...compose, 'exec', '-T', 'mcp-server', 'stat', '-c', '%a', '/app/data/bootstrap.json']), '600');
    // Simulate the previous service name using the same named configuration volume.
    const stage = mkdtempSync(join(tmpdir(), 'mcp-setup-rename-ci-'));
    try {
      const config = JSON.parse(docker([...compose, 'config', '--format', 'json']));
      const service = config.services['mcp-server'];
      delete service.depends_on;
      const legacy = join(stage, 'legacy.json');
      writeFileSync(legacy, JSON.stringify({ services: { app: service },
        networks: { default: { external: true, name: project + '_default' } },
        volumes: { app_data: { external: true, name: config.volumes.app_data.name } },
      }), { mode: 0o600 });
      docker([...compose, 'stop', 'mcp-server']);
      docker([...compose, 'rm', '-f', 'mcp-server']);
      docker(['compose', '-p', project, '-f', legacy, 'up', '-d', '--wait']);
      await waitFor(async () => (await fetch(base + '/api/health')).status === 200);
      execFileSync('bash', ['-c', 'source scripts/deployment-containers.sh; remove_legacy_apps "$1"', 'rename-ci', project], { stdio: 'pipe' });
      docker([...compose, 'up', '-d', '--wait', 'mcp-server']);
      assert.equal(docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project, '--filter', 'label=com.docker.compose.service=app']), '');
    } finally { rmSync(stage, { recursive: true, force: true }); }
    docker([...compose, 'up', '-d', '--force-recreate', '--wait', 'mcp-server']);
    await waitFor(async () => (await (await fetch(base + '/healthz')).json()).auth === true);
    const after = docker([...compose, 'exec', '-T', 'mcp-server', 'cat', '/app/data/bootstrap.json']);
    assert.ok(before === after, 'Persisted configuration and encryption key must survive recreation');
    assert.equal((await post('/setup/test')).status, 405);
    console.log('PASS: real PostgreSQL/Redis permissions, encoded passwords, independent setup steps, administrator, closed setup endpoints and persisted service rename/recreation');
  } finally {
    execFileSync('bash', ['-c', 'source scripts/deployment-containers.sh; remove_legacy_apps "$1"', 'cleanup-ci', project], { stdio: 'pipe' });
    docker([...compose, 'down', '-v']);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
