import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

// A fake Engine records the call order. Replacing a container is destructive, so
// the sequence itself is the behaviour worth pinning down without real Docker.
function fakeEngine(healthPort) {
  const calls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = (status, body = '') => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    };
    if (request.method === 'POST' && url.pathname === '/v1.44/images/create') {
      calls.push('pull');
      return reply(200, '{"status":"Pulling"}\n{"status":"Downloaded newer image"}\n');
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1.44/images/')) {
      return reply(200, JSON.stringify({ Id: 'sha256:new-image' }));
    }
    if (request.method === 'GET' && url.pathname === '/v1.44/containers/old-container/json') {
      calls.push('inspect');
      return reply(
        200,
        JSON.stringify({
          Id: 'old-container',
          Name: '/mcp-server-1',
          Config: { Env: ['NODE_ENV=production'], Labels: { 'com.docker.compose.service': 'mcp-server' } },
          HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: String(healthPort) }] } },
          NetworkSettings: { Networks: { control: { Aliases: ['mcp-server'] } } },
        }),
      );
    }
    if (request.method === 'POST' && url.pathname === '/v1.44/containers/old-container/rename') {
      calls.push(`rename:${url.searchParams.get('name')}`);
      return reply(204);
    }
    if (request.method === 'POST' && url.pathname === '/v1.44/containers/old-container/stop') {
      calls.push('stop');
      return reply(204);
    }
    if (request.method === 'POST' && url.pathname === '/v1.44/containers/create') {
      calls.push(`create:${url.searchParams.get('name')}`);
      return reply(201, JSON.stringify({ Id: 'new-container' }));
    }
    if (request.method === 'POST' && url.pathname === '/v1.44/containers/new-container/start') {
      calls.push('start');
      return reply(204);
    }
    if (request.method === 'DELETE' && url.pathname === '/v1.44/containers/mcp-server-1-rollback') {
      calls.push('clear-stale-rollback');
      return reply(204);
    }
    if (request.method === 'DELETE' && url.pathname === '/v1.44/containers/old-container') {
      calls.push('remove-old');
      return reply(204);
    }
    calls.push(`${request.method} ${url.pathname}`);
    return reply(404, '{"message":"unexpected"}');
  });
  return { server, calls };
}

test('the updater pulls, replaces the container and only then removes the old one', async () => {
  const socketPath = join(tmpdir(), `mcp-fake-docker-${process.pid}.sock`);
  const logPath = join(tmpdir(), `mcp-fake-update-${process.pid}.log`);
  rmSync(socketPath, { force: true });
  const health = createServer((_request, response) => response.writeHead(204).end());
  await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
  const healthPort = health.address().port;
  const engine = fakeEngine(healthPort);
  await new Promise((resolve) => engine.server.listen(socketPath, resolve));

  const child = spawn('node', ['scripts/update-container.mjs'], {
    env: {
      ...process.env,
      MCP_DOCKER_SOCKET: socketPath,
      MCP_UPDATE_OLD_ID: 'old-container',
      MCP_UPDATE_IMAGE: 'brandonvee/mcp-gateway:latest',
      MCP_UPDATE_LOG: logPath,
    },
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  const recorded = [...engine.calls];
  health.close();
  engine.server.close();
  rmSync(socketPath, { force: true });
  rmSync(logPath, { force: true });

  assert.equal(exitCode, 0);
  assert.deepEqual(recorded, [
    'pull',
    'inspect',
    'clear-stale-rollback',
    'rename:mcp-server-1-rollback',
    'stop',
    'create:mcp-server-1',
    'start',
    'remove-old',
  ]);
});
