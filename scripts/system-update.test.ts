import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { test } from 'node:test';
import {
  buildCreateSpec,
  buildUpdaterSpec,
  dockerSocket,
  parsePullProgress,
  selfId,
  updateEnabled,
  updateTargetImage,
} from '../packages/auth-server/src/system-update';

const inspect = {
  Id: 'old-container-id',
  Name: '/mcp-server-1',
  Config: {
    Image: 'brandonvee/mcp-gateway:v0.4.0',
    Env: ['NODE_ENV=production', 'CONFIG_FILE=/app/config/production.json'],
    Labels: { 'com.docker.compose.project': 'mcp-gateway', 'com.docker.compose.service': 'mcp-server' },
    Entrypoint: ['/sbin/tini', '--', 'node'],
    Cmd: ['/app/scripts/start-app.mjs'],
  },
  HostConfig: {
    Binds: ['/root/mcp/config.json:/app/config/production.json:ro'],
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
    RestartPolicy: { Name: 'unless-stopped' },
    NetworkMode: 'mcp-gateway_control',
  },
  NetworkSettings: { Networks: { 'mcp-gateway_control': { Aliases: ['mcp-server'] } } },
  Image: 'sha256:old',
};

test('the replacement keeps the runtime configuration but not the old image command', () => {
  const spec = buildCreateSpec(inspect, 'sha256:new');
  assert.equal(spec.Image, 'sha256:new');
  assert.deepEqual(spec.Env, inspect.Config.Env);
  assert.deepEqual(spec.Labels, inspect.Config.Labels);
  assert.equal(spec.Entrypoint, undefined);
  assert.equal(spec.Cmd, undefined);
  const hostConfig = spec.HostConfig as Record<string, unknown>;
  assert.deepEqual(hostConfig.Binds, inspect.HostConfig.Binds);
  assert.deepEqual(hostConfig.PortBindings, inspect.HostConfig.PortBindings);
  assert.deepEqual(hostConfig.RestartPolicy, inspect.HostConfig.RestartPolicy);
  // NetworkingConfig replaces NetworkMode: sending both makes the daemon fail.
  assert.equal(hostConfig.NetworkMode, undefined);
  assert.deepEqual(spec.NetworkingConfig, {
    EndpointsConfig: { 'mcp-gateway_control': { Aliases: ['mcp-server'] } },
  });
});

test('the updater runs on the host network with the socket and the log bind-mounted', () => {
  const spec = buildUpdaterSpec({
    imageId: 'sha256:old',
    oldId: 'old-container-id',
    targetImage: 'brandonvee/mcp-gateway:latest',
    socketPath: '/var/run/docker.sock',
    logPath: '/app/update.log',
    env: ['NODE_ENV=production'],
    groupIds: ['999'],
  });
  assert.equal(spec.Image, 'sha256:old');
  assert.deepEqual(spec.Cmd, ['/app/scripts/update-container.mjs']);
  const hostConfig = spec.HostConfig as Record<string, unknown>;
  assert.equal(hostConfig.NetworkMode, 'host');
  assert.equal(hostConfig.AutoRemove, true);
  assert.deepEqual(hostConfig.Binds, ['/var/run/docker.sock:/var/run/docker.sock', '/app/update.log:/app/update.log']);
  assert.deepEqual(hostConfig.GroupAdd, ['999']);
  const env = spec.Env as string[];
  assert.ok(env.includes('MCP_UPDATE_OLD_ID=old-container-id'));
  assert.ok(env.includes('MCP_UPDATE_IMAGE=brandonvee/mcp-gateway:latest'));
  assert.ok(env.includes('NODE_ENV=production'));
});

test('pull progress is parsed across chunk boundaries and reports the first error', () => {
  const parsed = parsePullProgress([
    '{"status":"Pulling from brandonvee/mcp-gateway"}\n{"status":"Download',
    'ing"}\n{"error":"manifest unknown"}\n{"status":"Ignored"}\n',
  ]);
  assert.deepEqual(parsed.statuses, ['Pulling from brandonvee/mcp-gateway', 'Downloading', 'Ignored']);
  assert.equal(parsed.error, 'manifest unknown');
  assert.deepEqual(parsePullProgress(['not json', '']), { statuses: [] });
});

test('the container identifies itself through HOSTNAME and falls back to the host name', () => {
  assert.equal(selfId({ HOSTNAME: 'abc123def456' }), 'abc123def456');
  assert.equal(selfId({}), hostname());
});

test('updates target :latest unless an explicit image is configured', () => {
  assert.equal(updateTargetImage(inspect), 'brandonvee/mcp-gateway:latest');
  assert.equal(updateTargetImage(inspect, { MCP_UPDATE_IMAGE: 'ghcr.io/example/app:v2' }), 'ghcr.io/example/app:v2');
  // A registry host with a port must not be split on its colon.
  assert.equal(updateTargetImage({ Config: { Image: 'localhost:5000/mcp-app:v1' } }), 'localhost:5000/mcp-app:latest');
  assert.equal(updateTargetImage({}), 'brandonvee/mcp-gateway:latest');
});

test('self-update uses the deployment flag and defaults to the standard socket', () => {
  assert.equal(updateEnabled({ MCP_UPDATE_ENABLED: 'true' }), true);
  assert.equal(updateEnabled({ MCP_UPDATE_ENABLED: 'false' }), false);
  assert.equal(updateEnabled({}), false);
  assert.equal(dockerSocket({}), '/var/run/docker.sock');
  assert.equal(dockerSocket({ MCP_DOCKER_SOCKET: '/tmp/docker.sock' }), '/tmp/docker.sock');
});

test('digest and replaced-container references retain the correct update repository', () => {
  assert.equal(
    updateTargetImage({ Config: { Image: 'localhost:5000/app@sha256:abc' } }, {}),
    'localhost:5000/app:latest',
  );
  assert.equal(
    updateTargetImage(
      { Config: { Image: 'sha256:abc', Labels: { 'com.mcp.update.image': 'example.com/team/app:v1' } } },
      {},
    ),
    'example.com/team/app:latest',
  );
  assert.equal(updateTargetImage({ Config: { Image: 'sha256:abc' } }, {}), 'brandonvee/mcp-gateway:latest');
});
