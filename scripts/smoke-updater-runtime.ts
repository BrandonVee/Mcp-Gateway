/** Verify updater socket permissions and host mount paths using disposable containers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  buildUpdaterSpec,
  dockerRequest,
  mountedSource,
  updaterGroups,
  type ContainerInspect,
} from '../packages/auth-server/src/system-update';

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const prefix = `mcp-updater-check-${randomUUID().slice(0, 8)}`;
const names = [`${prefix}-engine`, `${prefix}-app`, `${prefix}-worker`, `${prefix}-no-group`];
const volume = `${prefix}-data`;
const image = process.env.UPDATER_TEST_IMAGE ?? 'brandonvee/mcp-gateway:v0.5.3';
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

async function main() {
  const engineHost =
    process.env.DOCKER_HOST || JSON.parse(docker('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'));
  assert.ok(engineHost.startsWith('unix://'), 'This isolated check requires a local Unix Docker socket');
  const socketPath = engineHost.slice('unix://'.length);
  try {
    docker('volume', 'create', volume);
    const fakeEngine = `
      const fs = require('node:fs');
      const server = require('node:http').createServer((request, response) => {
        fs.appendFileSync('/fixture/requests', request.method + ' ' + request.url + '\\n');
        response.writeHead(500, {'content-type':'application/json'}).end(JSON.stringify({error:'regression probe: socket reachable'}));
      });
      server.listen('/fixture/docker.sock', () => {
        fs.chownSync('/fixture/docker.sock', 0, 34567);
        fs.chmodSync('/fixture/docker.sock', 0o660);
        fs.writeFileSync('/fixture/update.log', '');
        fs.chmodSync('/fixture/update.log', 0o666);
        fs.writeFileSync('/fixture/ready', 'ready');
      });
    `;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      names[0],
      '--user',
      '0',
      '--mount',
      `type=volume,src=${volume},dst=/fixture`,
      '--entrypoint',
      'node',
      image,
      '-e',
      fakeEngine,
    );
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        docker('exec', names[0], 'test', '-f', '/fixture/ready');
        ready = true;
        break;
      } catch {
        await pause();
      }
    }
    assert.ok(ready, 'fake Engine must start');
    const source = JSON.parse(docker('inspect', names[0]))[0].Mounts[0].Source as string;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      names[1],
      '--group-add',
      '34567',
      '--mount',
      `type=bind,src=${source}/docker.sock,dst=/var/run/docker.sock`,
      '--mount',
      `type=bind,src=${source}/update.log,dst=/app/update.log`,
      '--entrypoint',
      'node',
      image,
      '-e',
      'setInterval(() => {}, 1000)',
    );
    const inspect = JSON.parse(docker('inspect', names[1]))[0] as ContainerInspect & { Image: string };
    const spec = buildUpdaterSpec({
      imageId: inspect.Image,
      oldId: inspect.Id!,
      targetImage: 'example/probe:latest',
      socketPath: '/var/run/docker.sock',
      socketSource: mountedSource(inspect, '/var/run/docker.sock')!,
      logPath: '/app/update.log',
      logSource: mountedSource(inspect, '/app/update.log'),
      env: inspect.Config?.Env,
      groupIds: updaterGroups(inspect, '/not-mounted-on-client', {}),
    });
    // Keep only the disposable worker after exit so its status can be asserted.
    (spec.HostConfig as Record<string, unknown>).AutoRemove = false;
    // Reproduce the old failure first, without touching any real Engine socket.
    const noGroupSpec = structuredClone(spec);
    delete (noGroupSpec.HostConfig as Record<string, unknown>).GroupAdd;
    const noGroup = await dockerRequest('POST', '/containers/create', {
      socketPath,
      query: { name: names[3] },
      body: noGroupSpec,
    });
    assert.equal(noGroup.status, 201, noGroup.text);
    const noGroupId = (noGroup.json as { Id: string }).Id;
    assert.equal((await dockerRequest('POST', `/containers/${noGroupId}/start`, { socketPath })).status, 204);
    assert.equal(docker('wait', names[3]), '1');
    assert.match(docker('exec', names[1], 'cat', '/app/update.log'), /EACCES/);
    docker('exec', names[0], 'node', '-e', "require('node:fs').writeFileSync('/fixture/update.log', '')");
    const created = await dockerRequest('POST', '/containers/create', {
      socketPath,
      query: { name: names[2] },
      body: spec,
    });
    assert.equal(created.status, 201, created.text);
    const id = (created.json as { Id: string }).Id;
    const started = await dockerRequest('POST', `/containers/${id}/start`, { socketPath });
    assert.equal(started.status, 204, started.text);
    assert.equal(docker('wait', names[2]), '1', 'probe intentionally rejects the pull before any replacement');
    const log = docker('exec', names[1], 'cat', '/app/update.log');
    assert.match(log, /pulling example\/probe:latest/);
    assert.match(log, /regression probe: socket reachable/);
    const requests = docker('exec', names[0], 'cat', '/fixture/requests');
    assert.match(requests, /POST \/v1.44\/images\/create/);
    console.log(
      'Updater runtime check passed: reproduced missing-group EACCES; inherited group and host mounts restore socket access and persistent logs.',
    );
  } finally {
    for (const name of names.reverse()) {
      try {
        docker('rm', '-f', name);
      } catch {
        /* Already removed. */
      }
    }
    try {
      docker('volume', 'rm', volume);
    } catch {
      /* Reported by prior assertions. */
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
