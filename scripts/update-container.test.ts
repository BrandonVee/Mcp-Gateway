import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

// A fake Engine records the call order. Replacing a container is destructive, so
// the sequence itself is the behaviour worth pinning down without real Docker.
function fakeEngine(healthPort, failure = '', name = 'mcp-server-1') {
  const calls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = (status, body = '') => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    };
    if (request.method === 'POST' && url.pathname === '/v1.44/images/create') {
      calls.push('pull');
      assert.equal(url.searchParams.get('tag'), failure === 'digest' ? null : 'latest');
      if (failure === 'digest') assert.match(url.searchParams.get('fromImage'), /@sha256:/);
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
          Name: `/${name}`,
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
      return reply(
        failure === 'create' ? 500 : 201,
        JSON.stringify(failure === 'create' ? { message: 'create failed' } : { Id: 'new-container' }),
      );
    }
    if (request.method === 'POST' && url.pathname === '/v1.44/containers/new-container/start') {
      calls.push('start');
      return reply(failure === 'start' ? 500 : 204);
    }
    if (request.method === 'DELETE' && url.pathname === `/v1.44/containers/${name}-rollback`) {
      calls.push('clear-stale-rollback');
      return reply(204);
    }
    if (request.method === 'POST' && url.pathname === '/v1.44/containers/old-container/start') {
      calls.push('restart-old');
      return reply(204);
    }
    if (request.method === 'DELETE' && url.pathname === '/v1.44/containers/new-container') {
      calls.push('remove-new');
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

for (const name of ['mcp-server-1', 'mcp-gateway-server']) {
  test(`the updater preserves ${name} and only removes the old container after replacement`, async () => {
    const socketPath = join(tmpdir(), `mcp-fake-docker-${process.pid}.sock`);
    const logPath = join(tmpdir(), `mcp-fake-update-${process.pid}.log`);
    rmSync(socketPath, { force: true });
    const health = createServer((_request, response) => response.writeHead(204).end());
    await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
    const healthPort = health.address().port;
    const engine = fakeEngine(healthPort, '', name);
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
      `rename:${name}-rollback`,
      'stop',
      `create:${name}`,
      'start',
      'remove-old',
    ]);
  });
}

for (const failure of ['create', 'start', 'digest']) {
  test(`the updater handles ${failure} without losing the previous container`, async () => {
    const socketPath = join(tmpdir(), `mcp-fake-docker-${process.pid}-${failure}.sock`);
    rmSync(socketPath, { force: true });
    const health = createServer((_request, response) => response.writeHead(204).end());
    await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
    const engine = fakeEngine(health.address().port, failure);
    await new Promise((resolve) => engine.server.listen(socketPath, resolve));
    try {
      const child = spawn('node', ['scripts/update-container.mjs'], {
        env: {
          ...process.env,
          MCP_DOCKER_SOCKET: socketPath,
          MCP_UPDATE_OLD_ID: 'old-container',
          MCP_UPDATE_IMAGE:
            failure === 'digest' ? `brandonvee/mcp-gateway@sha256:${'a'.repeat(64)}` : 'brandonvee/mcp-gateway:latest',
          MCP_UPDATE_LOG: '',
        },
        stdio: 'ignore',
      });
      const exitCode = await new Promise((resolve) => child.on('exit', resolve));
      assert.equal(exitCode, failure === 'digest' ? 0 : 1);
      if (failure === 'digest') assert.ok(engine.calls.includes('remove-old'));
      else {
        assert.ok(engine.calls.includes('rename:mcp-server-1'));
        assert.ok(engine.calls.includes('restart-old'));
        assert.equal(engine.calls.includes('remove-old'), false);
        assert.equal(engine.calls.includes('remove-new'), failure === 'start');
      }
    } finally {
      await Promise.all([
        new Promise((resolve) => health.close(resolve)),
        new Promise((resolve) => engine.server.close(resolve)),
      ]);
      rmSync(socketPath, { force: true });
    }
  });
}
