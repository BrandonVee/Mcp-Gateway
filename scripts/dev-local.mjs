import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localEnvPath = join(root, '.env.local');
const children = [];
let stopping = false;

function loadLocalEnv() {
  if (!existsSync(localEnvPath)) return;
  for (const line of readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].trim();
    process.env[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
}

function ensureLocalSecrets() {
  const generated = [];
  if (!process.env.CREDENTIAL_ENCRYPT_KEY) {
    process.env.CREDENTIAL_ENCRYPT_KEY = randomBytes(32).toString('hex');
    generated.push(`CREDENTIAL_ENCRYPT_KEY=${process.env.CREDENTIAL_ENCRYPT_KEY}`);
  }
  if (!process.env.CREDENTIAL_BROKER_TOKEN) {
    process.env.CREDENTIAL_BROKER_TOKEN = randomBytes(32).toString('hex');
    generated.push(`CREDENTIAL_BROKER_TOKEN=${process.env.CREDENTIAL_BROKER_TOKEN}`);
  }
  if (generated.length) {
    const prefix = existsSync(localEnvPath) ? '\n' : '# Local development secrets. Keep this file private.\n';
    writeFileSync(localEnvPath, `${prefix}${generated.join('\n')}\n`, { mode: 0o600, flag: 'a' });
    console.log('[local] generated missing secrets in .env.local');
  }
}

function tcpOpen(host, port, timeout = 1500) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(open);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function verifyPostgres(connectionString) {
  const requireAuth = createRequire(join(root, 'packages/auth-server/package.json'));
  const { Client } = requireAuth('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    const url = new URL(connectionString);
    const account = decodeURIComponent(url.username || '(empty)');
    const address = `${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)}`;
    if (error?.code === '28P01' || error?.code === '28000') {
      throw new Error(`PostgreSQL rejected user "${account}" at ${address} (${error.code}). Set a working DATABASE_URL in .env.local, or create/reset this database role. The app has not started.`);
    }
    if (error?.code === '3D000') {
      throw new Error(`PostgreSQL database at ${address} does not exist. Create it or set DATABASE_URL in .env.local. The app has not started.`);
    }
    throw new Error(`PostgreSQL connection failed at ${address}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyRedis(url) {
  const requireGateway = createRequire(join(root, 'packages/gateway/package.json'));
  const Redis = requireGateway('ioredis');
  const client = new Redis(url, { lazyConnect: true, connectTimeout: 3000, retryStrategy: null });
  try {
    if (await client.ping() !== 'PONG') throw new Error('PING did not return PONG');
  } catch (error) {
    throw new Error(`Redis PING failed at ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    client.disconnect();
  }
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { process: child } of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The process may already have exited.
    }
  }
  process.exitCode = code;
}

function start(label, filter, extraEnv = {}) {
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', filter, 'dev'], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  children.push({ label, process: child });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) console.log(`[${label}] ${line}`);
      }
    });
  }
  child.on('error', (error) => {
    if (!stopping) {
      console.error(`[local] ${label} failed: ${error.message}`);
      stopAll(1);
    }
  });
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[local] ${label} exited (${code ?? 'signal'})`);
      stopAll(1);
    }
  });
}

async function waitFor(label, url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // The process may still be starting.
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new Error(`${label} did not become healthy at ${url}`);
}

async function main() {
  loadLocalEnv();
  ensureLocalSecrets();
  const configPath = process.env.CONFIG_FILE
    ? (isAbsolute(process.env.CONFIG_FILE) ? process.env.CONFIG_FILE : resolve(root, process.env.CONFIG_FILE))
    : join(root, 'config/default.json');
  process.env.CONFIG_FILE = configPath;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const fixtures = JSON.parse(readFileSync(join(root, 'scripts/dev-fixtures.json'), 'utf8'));
  process.env.ADMIN_WEB_URL ??= 'http://localhost:5173';
  process.env.CONNECTIONS_WEB_URL ??= 'http://localhost:5173/connections';

  const postgres = new URL(process.env.DATABASE_URL ?? config.auth.postgres.url);
  const redis = new URL(process.env.REDIS_URL ?? config.gateway.redisUrl);
  const dependencies = [
    ['PostgreSQL', postgres.hostname, Number(postgres.port || 5432)],
    ['Redis', redis.hostname, Number(redis.port || 6379)],
  ];
  for (const [label, host, port] of dependencies) {
    if (!(await tcpOpen(host, port))) {
      throw new Error(`${label} is not reachable at ${host}:${port}. Start it locally and check config/default.json or .env.local.`);
    }
  }
  await verifyPostgres(postgres.toString());
  await verifyRedis(redis.toString());

  const instances = fixtures.servers.flatMap((server) => server.instances.map((instance) => ({
    ...instance,
    serverName: server.name,
  })));
  const listeners = [
    ['Auth Server', 'localhost', config.auth.port],
    ['Gateway', 'localhost', config.gateway.port],
    ['Admin Web', 'localhost', 5173],
    ...instances.map((instance) => ['MCP ' + instance.id, 'localhost', instance.port]),
  ];
  for (const [label, host, port] of listeners) {
    if (await tcpOpen(host, port)) {
      throw new Error(`${label} port ${host}:${port} is already in use. Stop the existing service or change the local configuration.`);
    }
  }

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  start('auth', '@mcp/auth-server');
  await waitFor('Auth Server', `http://localhost:${config.auth.port}/health`);
  for (const instance of instances) {
    start(instance.id, '@mcp/mcp-server', {
      MCP_INSTANCE_ID: instance.id,
      MCP_SERVER_NAME: instance.serverName,
      MCP_PORT: String(instance.port),
      ...(instance.serverName === 'reports' ? { MCP_DEMO_API_KEY: 'smoke-user-key' } : {}),
    });
  }
  await Promise.all(instances.map((instance) => {
    return waitFor(instance.id, `http://localhost:${instance.port}/health`);
  }));
  start('gateway', '@mcp/gateway');
  await waitFor('Gateway', `http://localhost:${config.gateway.port}/health`);
  start('admin-web', '@mcp/admin-web');
  await waitFor('Admin Web', 'http://localhost:5173/');
  console.log('\n[local] Ready: http://localhost:5173  |  connections: /connections  |  gateway: http://localhost:8000');
  console.log('[local] Press Ctrl+C to stop all Node services. PostgreSQL and Redis remain running.\n');
}

main().catch((error) => {
  console.error(`[local] ${error instanceof Error ? error.message : String(error)}`);
  stopAll(1);
});
