/** Fresh image, authenticated setup, actual dependency permissions and persisted restart. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    const token = docker([...compose, 'exec', '-T', 'app', 'cat', '/app/data/setup-token']);
    const post = (path: string, body = input, secret = token, origin = base) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': secret, origin }, body: JSON.stringify(body) });
    assert.equal((await post('/setup/test', input, 'bad')).status, 401);
    assert.equal((await post('/setup/test', input, token, 'https://evil.example')).status, 403);
    assert.equal((await post('/setup/test', { ...input, postgres: { ...input.postgres, password: 'wrong' } })).status, 422);
    docker([...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-c', "CREATE ROLE limited LOGIN PASSWORD 'limited-ci-password'; GRANT CONNECT ON DATABASE mcp TO limited;"]);
    assert.equal((await post('/setup/test', { ...input, postgres: { ...input.postgres, username: 'limited', password: 'limited-ci-password' } })).status, 422);
    assert.equal((await post('/setup/test', { ...input, redis: { ...input.redis, password: 'wrong' } })).status, 422);
    assert.equal((await post('/setup/test')).status, 200);
    assert.equal((await post('/setup/install')).status, 201);
    await waitFor(async () => (await (await fetch(base + '/healthz')).json()).auth === true);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/gateway/health')).status, 200);
    assert.equal((await post('/setup/install')).status, 405);
    assert.equal(docker([...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-Atc', "SELECT username FROM users WHERE role='admin'"]), input.adminUsername);
    assert.equal(docker([...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-Atc', "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'mcp_setup_%'"]), '0');
    const before = docker([...compose, 'exec', '-T', 'app', 'cat', '/app/data/bootstrap.json']);
    assert.equal(docker([...compose, 'exec', '-T', 'app', 'stat', '-c', '%a', '/app/data/bootstrap.json']), '600');
    docker([...compose, 'up', '-d', '--force-recreate', '--wait', 'app']);
    await waitFor(async () => (await (await fetch(base + '/healthz')).json()).auth === true);
    const after = docker([...compose, 'exec', '-T', 'app', 'cat', '/app/data/bootstrap.json']);
    assert.ok(before === after, 'Persisted configuration and encryption key must survive recreation');
    assert.equal((await post('/setup/test')).status, 405);
    console.log('PASS: real PostgreSQL/Redis permissions, encoded passwords, browser setup, administrator, closed setup endpoints and persisted recreation');
  } finally { docker([...compose, 'down', '-v']); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
