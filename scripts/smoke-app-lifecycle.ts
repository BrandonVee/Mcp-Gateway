/** Process supervision checks for a disposable single-host deployment. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readDeploymentEnvironment } from './deploy-env.js';

const directory = process.env.MCP_DEPLOY_DIR;
if (!directory || !process.env.COMPOSE_PROJECT_NAME?.includes('ci')) throw new Error('Use a disposable CI deployment');
const envFile = resolve(directory, 'runtime.env');
const saved = readDeploymentEnvironment(envFile);
const base = `http://127.0.0.1:${saved.MCP_HTTP_PORT}`;
const compose = ['compose', '--env-file', envFile, '-f', 'deploy/compose.single-host.yml'];
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const id = docker([...compose, 'ps', '-q', 'mcp-server']);
assert.ok(id);
const state = () => JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]));
const restarts = () => Number(docker(['inspect', '--format', '{{.RestartCount}}', id]));
const gatewaySignal = (signal: string) =>
  docker([
    ...compose,
    'exec',
    '-T',
    'mcp-server',
    'node',
    '-e',
    `
  const fs=require('node:fs');
  for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))) {
    let args;try{args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');}catch{continue;}
    if(args.includes('/app/packages/gateway/dist/index.js')) {process.kill(Number(pid),'${signal}');process.exit(0);}
  }
  process.exit(1);
`,
  ]);
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await check()) return;
    } catch {
      /* Restarting. */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.fail('Unified application did not reach the expected state');
}
async function main() {
  const bad = spawnSync(
    'docker',
    [...compose, 'run', '--rm', '--no-deps', '-e', 'CONFIG_FILE=/missing-config.json', 'mcp-server'],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(bad.status, 1, bad.stderr);
  docker([
    ...compose,
    'exec',
    '-T',
    'mcp-server',
    'node',
    '-e',
    `
    const os=require('node:os');
    const ip=Object.values(os.networkInterfaces()).flat().find(n=>n.family==='IPv4'&&!n.internal).address;
    (async()=>{for(const port of [9001,8000,9002]) {
      let reachable=false;try{await fetch('http://'+ip+':'+port+'/health',{signal:AbortSignal.timeout(1000)});reachable=true;}catch{}
      if(reachable)throw new Error('Internal port exposed: '+port);
    }})().catch(()=>process.exit(1));
  `,
  ]);
  gatewaySignal('SIGSTOP');
  try {
    await waitFor(async () => (await fetch(base + '/healthz')).status === 503);
  } finally {
    gatewaySignal('SIGCONT');
  }
  await waitFor(async () => (await fetch(base + '/healthz')).ok);
  const before = restarts();
  gatewaySignal('SIGTERM');
  await waitFor(async () => restarts() > before && state().Health?.Status === 'healthy');
  docker([...compose, 'stop', 'mcp-server']);
  assert.equal(state().ExitCode, 0, 'Docker stop must complete without a forced kill');
  docker([...compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', 'mcp-server']);
  await waitFor(async () => (await fetch(base + '/healthz')).ok);
  console.log(
    'PASS: startup failure, private internal ports, aggregate readiness, child-failure restart and clean container shutdown',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
