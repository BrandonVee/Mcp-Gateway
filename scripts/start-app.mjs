import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEnvironment } from './setup-server.mjs';

// All children share this container's lifetime. Failures restart the whole app.
const children = [];
let stopping = false;
let ready = false;
let health;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stop(code) {
  if (stopping) return;
  stopping = true;
  ready = false;
  health?.close();
  for (const { child, name } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(name === 'web' ? 'SIGQUIT' : 'SIGTERM');
  }
  const deadline = Date.now() + 8000;
  while (children.some(({ child }) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await sleep(50);
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  process.exit(code);
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));

function launch(name, command, args, env) {
  const child = spawn(command, args, { stdio: 'inherit', env });
  children.push({ name, child });
  child.once('error', () => {
    if (!stopping) { console.error(`[app] ${name} could not start`); void stop(1); }
  });
  child.once('exit', (code, signal) => {
    if (!stopping) { console.error(`[app] ${name} exited (${signal ?? code})`); void stop(1); }
  });
}
async function healthy(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); await response.arrayBuffer(); return response.ok; }
  catch { return false; }
}
async function waitFor(url, name) {
  const deadline = Date.now() + 120000;
  while (!stopping && Date.now() < deadline) {
    if (await healthy(url)) return;
    await sleep(250);
  }
  throw new Error(`${name} did not become ready`);
}

try {
  const config = JSON.parse(readFileSync(process.env.CONFIG_FILE ?? '/app/config/app.json', 'utf8'));
  const environment = await prepareEnvironment(process.env);
  // Old backups reference the former auth container. Normalize only local links.
  config.auth.port = 9001;
  config.gateway.port = 8000;
  config.gateway.authJwksUrl = 'http://127.0.0.1:9001/jwks.json';
  config.gateway.registryUrl = 'http://127.0.0.1:9001/internal/mcp-servers';
  const runtimeFile = join(mkdtempSync(join(tmpdir(), 'mcp-app-')), 'config.json');
  writeFileSync(runtimeFile, JSON.stringify(config), { mode: 0o600 });
  const authEnv = { ...environment, CONFIG_FILE: runtimeFile, AUTH_LISTEN_HOST: process.env.AUTH_LISTEN_HOST ?? '127.0.0.1',
    AUTH_TRUSTED_PROXY_IPS: [process.env.AUTH_TRUSTED_PROXY_IPS, '127.0.0.1'].filter(Boolean).join(',') };
  const gatewayEnv = { ...environment, CONFIG_FILE: runtimeFile, GATEWAY_LISTEN_HOST: process.env.GATEWAY_LISTEN_HOST ?? '127.0.0.1' };
  for (const key of ['CREDENTIAL_ENCRYPT_KEY', 'DATABASE_URL', 'ADMIN_PASSWORD']) delete gatewayEnv[key];

  health = createServer(async (req, res) => {
    const alive = ready && !stopping && children.length === 3 && children.every(({ child }) => child.exitCode === null && child.signalCode === null);
    const [auth, gateway] = alive ? await Promise.all([healthy('http://127.0.0.1:9001/health'), healthy('http://127.0.0.1:8000/health')]) : [false, false];
    const ok = alive && auth && gateway;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok, auth, gateway }));
  });
  await new Promise((resolve, reject) => { health.once('error', reject); health.listen(9002, '127.0.0.1', resolve); });
  launch('auth', process.execPath, ['/app/packages/auth-server/dist/index.js'], authEnv);
  await waitFor('http://127.0.0.1:9001/health', 'auth');
  launch('gateway', process.execPath, ['/app/packages/gateway/dist/index.js'], gatewayEnv);
  await waitFor('http://127.0.0.1:8000/health', 'gateway');
  launch('web', 'nginx', ['-c', '/app/deploy/nginx-main.conf', '-g', 'daemon off;'], { PATH: process.env.PATH });
  await waitFor('http://127.0.0.1:8080/', 'web');
  ready = true;
  console.log('[app] ready on :8080');
} catch {
  if (!stopping) { console.error('[app] startup failed; check service logs and configuration'); await stop(1); }
}
