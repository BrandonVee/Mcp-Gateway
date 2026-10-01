import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Standalone runtime JavaScript is copied directly into the image.
import { startSetupServer, setupCandidate, loadSetupEnvironment, needsSetup, prepareEnvironment } from './setup-server.mjs';
const input = {
  postgres: { host: 'postgres', username: 'mcp', password: 'pg:@#$/密码', database: 'mcp', port: 5432 },
  redis: { host: 'redis', password: 'redis:@#$/密码', database: 0 },
  adminUsername: 'admin', adminPassword: 'strong-admin-password-123456',
};
test('setup encodes credentials and validates ports, TLS, admin and existing keys', () => {
  const candidate = setupCandidate(input, {});
  assert.equal(decodeURIComponent(new URL(candidate.DATABASE_URL).password), input.postgres.password);
  assert.equal(decodeURIComponent(new URL(candidate.REDIS_URL).password), input.redis.password);
  assert.notEqual(candidate.INTERNAL_API_TOKEN, candidate.CREDENTIAL_BROKER_TOKEN);
  assert.match(candidate.CREDENTIAL_ENCRYPT_KEY, /^[a-f0-9]{64}$/);
  assert.equal(new URL(setupCandidate({ ...input, redis: { ...input.redis, tls: true } }, {}).REDIS_URL).protocol, 'rediss:');
  for (const port of [0, -1, 65536, 1.5]) assert.throws(() => setupCandidate({ ...input, postgres: { ...input.postgres, port: String(port) } }, {}));
  assert.throws(() => setupCandidate({ ...input, postgres: { url: 'http://user:secret@host/' } }, {}));
  assert.throws(() => setupCandidate({ ...input, adminPassword: 'short' }, {}));
  assert.throws(() => setupCandidate(input, { CREDENTIAL_ENCRYPT_KEY: 'bad' }));
  const key = 'a'.repeat(64);
  assert.equal(setupCandidate(input, { CREDENTIAL_ENCRYPT_KEY: key }).CREDENTIAL_ENCRYPT_KEY, key);
});
test('setup requires secret and same origin; tests do not save; failure can retry; installation is atomic and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-setup-test-'));
  let fail = false, checks = 0;
  const logs: string[] = [];
  const setup = await startSetupServer({ directory, env: {}, port: 0, host: '127.0.0.1', log: (v: string) => logs.push(v), check: async () => { checks++; if (fail) throw new Error('sanitized connection failure'); } });
  const base = `http://127.0.0.1:${setup.address.port}`;
  const post = (path = '/setup/test', token = setup.token, extra: Record<string, string> = {}, body = input) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': token, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base)).status, 200);
    const page = await (await fetch(base)).text();
    assert.ok(!page.includes(setup.token) && !page.includes(input.postgres.password));
    assert.equal((await fetch(base + '/setup.js')).status, 200);
    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, mode: 'setup', ready: false });
    assert.equal((await post('/setup/test', 'wrong')).status, 401);
    assert.equal((await post('/setup/test', setup.token, { origin: 'https://attacker.example' })).status, 403);
    assert.equal(checks, 0);
    assert.equal((await post('/setup/test', setup.token, {}, { ...input, adminPassword: 'short' })).status, 400);
    fail = true;
    assert.equal((await post()).status, 422);
    assert.equal(existsSync(join(directory, 'bootstrap.json')), false);
    fail = false;
    assert.equal((await post('/setup/test', setup.token, { origin: base })).status, 200);
    assert.equal(existsSync(join(directory, 'bootstrap.json')), false);
    assert.equal(statSync(join(directory, 'setup-token')).mode & 0o777, 0o600);
    assert.equal((await post('/setup/install')).status, 201);
    const env = await setup.completed;
    assert.equal(needsSetup(env), false);
    assert.equal(existsSync(join(directory, 'setup-token')), false);
    assert.equal(statSync(join(directory, 'bootstrap.json')).mode & 0o777, 0o600);
    assert.deepEqual(loadSetupEnvironment(directory, {}), env);
    assert.equal(loadSetupEnvironment(directory, { DATABASE_URL: 'postgres://override/mcp' }).DATABASE_URL, 'postgres://override/mcp');
    assert.equal(logs.some(line => line.includes(input.postgres.password) || line.includes(input.adminPassword)), false);
    assert.ok(readFileSync(join(directory, 'bootstrap.json'), 'utf8').includes('"version":1'));
  } finally { setup.server.closeAllConnections(); await new Promise<void>(done => setup.server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});
test('concurrent installs cannot create different persisted encryption keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-setup-race-'));
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const setup = await startSetupServer({ directory, env: {}, port: 0, host: '127.0.0.1', log: () => {}, check: () => barrier });
  const url = `http://127.0.0.1:${setup.address.port}/setup/install`;
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': setup.token }, body: JSON.stringify(input) });
  try {
    const first = post();
    await new Promise(done => setTimeout(done, 30));
    assert.equal((await post()).status, 409);
    release();
    assert.equal((await first).status, 201);
    await setup.completed;
  } finally { release(); setup.server.closeAllConnections(); await new Promise<void>(done => setup.server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('development file configuration bypasses production browser setup without touching disk', async () => {
  const env = { NODE_ENV: 'development', MCP_DATA_DIR: '/missing/read-only/setup-ci', CONFIG_FILE: '/app/config/input.json' };
  assert.deepEqual(await prepareEnvironment(env), env);
});

test('each setup connection test works without the other dependency or administrator and never persists a draft', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-setup-steps-'));
  let pgChecks = 0, redisChecks = 0, finalChecks = 0, failPg = false;
  const setup = await startSetupServer({ directory, env: {}, port: 0, host: '127.0.0.1', log: () => {},
    checkPostgres: async (env: Record<string, string>) => { assert.ok(env.DATABASE_URL); assert.equal(env.REDIS_URL, undefined); pgChecks++; if (failPg) throw new Error('PostgreSQL connection failed'); },
    checkRedis: async (env: Record<string, string>) => { assert.ok(env.REDIS_URL); assert.equal(env.DATABASE_URL, undefined); redisChecks++; },
    check: async () => { finalChecks++; },
  });
  const base = `http://127.0.0.1:${setup.address.port}`;
  const post = (path: string, body: object, token = setup.token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/setup/verify', {}, 'bad')).status, 401);
    assert.equal((await post('/setup/test-postgres', { postgres: input.postgres }, 'bad')).status, 401);
    assert.equal((await post('/setup/test-redis', { redis: input.redis }, 'bad')).status, 401);
    assert.equal((await post('/setup/verify', {})).status, 200);
    assert.equal(pgChecks + redisChecks + finalChecks, 0);
    assert.equal((await post('/setup/test-postgres', { postgres: input.postgres })).status, 200);
    assert.equal(pgChecks, 1); assert.equal(redisChecks, 0);
    assert.equal((await post('/setup/test-redis', { redis: input.redis })).status, 200);
    assert.equal(redisChecks, 1);
    assert.equal((await post('/setup/test-redis', {})).status, 400);
    failPg = true;
    assert.equal((await post('/setup/test-postgres', { postgres: input.postgres })).status, 422);
    failPg = false;
    assert.equal((await post('/setup/test-postgres', { postgres: input.postgres })).status, 200);
    assert.equal(existsSync(join(directory, 'bootstrap.json')), false);
    assert.equal((await post('/setup/install', { postgres: input.postgres })).status, 400);
    assert.equal(finalChecks, 0);
    assert.equal((await post('/setup/install', input)).status, 201);
    await setup.completed;
    assert.equal(finalChecks, 1, 'Final install must check both dependencies again');
  } finally { setup.server.closeAllConnections(); await new Promise<void>(done => setup.server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});
