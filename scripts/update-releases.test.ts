import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compareVersions,
  parseReleases,
  parseImageTags,
  fetchPublishedReleases,
  stableVersion,
} from '../packages/auth-server/src/update-releases';
import {
  getUpdateStatus,
  getUpdateTaskStatus,
  officialUpdateImage,
  runningVersion,
  startUpdate,
} from '../packages/auth-server/src/system-update';

const digest = `sha256:${'a'.repeat(64)}`;
const oldDigest = `sha256:${'b'.repeat(64)}`;
const release = (tag: string, hash = digest) => ({
  tag_name: tag,
  body: `Digest: \`${hash}\``,
  draft: false,
  prerelease: false,
});

test('versions compare numerically and release list excludes unpublished/uninstallable entries', () => {
  assert.equal(stableVersion('v0.5.2'), '0.5.2');
  for (const invalid of ['latest', 'v01.2.3', 'v1.2.3-beta', '1.2', '1.2.3/other', null])
    assert.equal(stableVersion(invalid), '');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  const parsed = parseReleases([
    release('v0.9.9'),
    release('v0.10.0'),
    release('v0.10.0'),
    { ...release('v2.0.0'), draft: true },
    { ...release('v3.0.0'), prerelease: true },
    release('v4.0.0-rc'),
    release('v5.0.0', 'bad-digest'),
    release('6.0.0'),
    null,
  ]);
  assert.deepEqual(
    parsed.map((item) => item.tag),
    ['v0.10.0', 'v0.9.9'],
  );
  assert.throws(() => parseReleases({ message: 'rate limited' }));
});

test('running version uses immutable image evidence and ignores misleading latest labels', () => {
  const releases = parseReleases([release('v0.5.2')]);
  assert.equal(runningVersion({ RepoDigests: [`brandonvee/mcp-gateway@${digest}`] }, releases, '0.5.1'), '0.5.2');
  assert.equal(runningVersion({ Config: { Labels: { 'org.opencontainers.image.version': 'latest' } } }, releases), '');
  assert.equal(runningVersion({}, releases, '0.5.3'), '0.5.3');
  assert.equal(
    runningVersion({ Config: { Labels: { 'org.opencontainers.image.revision': 'c'.repeat(40) } } }, [
      { ...releases[0], revision: 'c'.repeat(40) },
    ]),
    '0.5.2',
  );
  assert.equal(officialUpdateImage('brandonvee/mcp-gateway:latest'), true);
  assert.equal(officialUpdateImage('docker.io/brandonvee/mcp-gateway@sha256:abc'), true);
  assert.equal(officialUpdateImage('example.com/brandonvee/mcp-gateway:latest'), false);
});

test('status, cached release checks and selected updates use the running image and approved digest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-update-status-'));
  const socket = join(directory, 'docker.sock');
  const env = {
    MCP_UPDATE_ENABLED: 'true',
    MCP_DOCKER_SOCKET: socket,
    HOSTNAME: 'old',
    MCP_UPDATE_LOG: '/tmp/update.log',
  };
  const originalFetch = globalThis.fetch;
  let checks = 0,
    failCheck = false,
    createConflict = false;
  let createdBody:
    | { Env?: string[]; HostConfig?: { GroupAdd?: string[]; Mounts?: Array<{ Source: string; Target: string }> } }
    | undefined;
  let currentDigest = oldDigest;
  globalThis.fetch = async () => {
    checks++;
    return new Response(
      JSON.stringify(failCheck ? { message: 'rate limit' } : [release('v0.5.3'), release('v0.5.2', oldDigest)]),
      { status: failCheck ? 403 : 200 },
    );
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const reply = (body: unknown, status = 200) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/v1.44/containers/old/json')
      return reply({
        Id: 'old',
        Image: 'sha256:image',
        Name: '/app',
        State: { Running: true, Health: { Status: 'healthy' } },
        Config: { Image: 'brandonvee/mcp-gateway:latest', Env: ['SECRET=retained'] },
        HostConfig: { GroupAdd: ['998'] },
        Mounts: [
          { Source: socket, Destination: socket },
          { Source: '/srv/mcp/update.log', Destination: '/tmp/update.log' },
        ],
      });
    if (url.pathname.startsWith('/v1.44/images/'))
      return reply({ RepoDigests: [`brandonvee/mcp-gateway@${currentDigest}`] });
    if (url.pathname === '/v1.44/containers/create') {
      let body = '';
      for await (const chunk of request) body += chunk;
      createdBody = JSON.parse(body);
      assert.equal(url.searchParams.get('name'), 'mcp-updater-old');
      return reply({ Id: 'updater' }, createConflict ? 409 : 201);
    }
    if (url.pathname === '/v1.44/containers/updater/start') return reply({}, 204);
    reply({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const status = await getUpdateStatus(env);
    assert.equal(status.version, '0.5.2');
    assert.equal(status.container_ready, true);
    assert.equal(status.latest_version, '0.5.3');
    assert.equal(status.update_available, true);
    assert.equal(status.release_check_error, false);
    await getUpdateStatus(env);
    assert.equal(checks, 1);
    currentDigest = digest;
    assert.equal((await getUpdateStatus(env)).update_available, false);
    await assert.rejects(startUpdate(env, 'v999.0.0'), /invalid_update_version/);
    await assert.rejects(startUpdate(env, 'other\/image:tag'), /invalid_update_version/);
    const started = await startUpdate(env, 'v0.5.3');
    assert.equal(started.image, `brandonvee/mcp-gateway@${digest}`);
    assert.ok(createdBody?.Env?.includes(`MCP_UPDATE_IMAGE=brandonvee/mcp-gateway@${digest}`));
    assert.ok(createdBody?.Env?.includes('SECRET=retained'));
    assert.ok(createdBody?.HostConfig?.GroupAdd?.includes('998'));
    assert.ok(
      createdBody?.HostConfig?.Mounts?.some(
        (mount) => mount.Source === '/srv/mcp/update.log' && mount.Target === '/tmp/update.log',
      ),
    );
    createConflict = true;
    await assert.rejects(startUpdate(env), /system_update_in_progress/);
    createConflict = false;
    failCheck = true;
    const failed = await getUpdateStatus(env, true);
    assert.equal(failed.release_check_error, true);
    assert.equal(failed.update_available, null);
    assert.equal(failed.releases.length, 2);
    assert.equal((await getUpdateStatus(env)).release_check_error, true);
    const custom = await getUpdateStatus({ ...env, MCP_UPDATE_IMAGE: 'example.com/app:latest' });
    assert.equal(custom.releases_supported, false);
    assert.equal(custom.release_check_error, false);
    assert.equal(custom.update_available, null);
    assert.equal((await startUpdate(env)).image, 'brandonvee/mcp-gateway:latest');
    await assert.rejects(
      startUpdate({ ...env, MCP_UPDATE_IMAGE: 'example.com/app:latest' }, 'v0.5.3'),
      /invalid_update_version/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GitHub failures fall back to published Docker Hub digests without requiring credentials', async () => {
  const calls: string[] = [];
  const hub = {
    results: [
      { name: 'v0.5.3', digest, tag_status: 'active', images: [{ digest: oldDigest, status: 'active' }] },
      { name: 'latest', digest, tag_status: 'active' },
      { name: 'v0.6.0', digest, tag_status: 'inactive' },
      { name: 'v0.7.0-beta', digest, tag_status: 'active' },
      { name: 'v0.8.0', digest: 'bad', tag_status: 'active' },
    ],
  };
  const releases = await fetchPublishedReleases(async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? new Response('{}', { status: 403 }) : new Response(JSON.stringify(hub));
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/hub\.docker\.com\//);
  assert.deepEqual(
    releases.map((release) => release.tag),
    ['v0.5.3'],
  );
  assert.equal(runningVersion({ RepoDigests: [`brandonvee/mcp-gateway@${oldDigest}`] }, releases), '0.5.3');
  assert.throws(() => parseImageTags({ results: null }));
  await assert.rejects(
    fetchPublishedReleases(async () => new Response('{}', { status: 429 })),
    /image version check failed/,
  );
  await assert.rejects(
    fetchPublishedReleases(async () => {
      throw new Error('network unavailable');
    }),
    /network unavailable/,
  );
});

test('worker status distinguishes running, failed, removed and unrelated Docker containers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-update-task-'));
  const socket = join(directory, 'docker.sock');
  const id = 'd'.repeat(64);
  let status = 'running',
    code = 0,
    removed = false,
    managed = true;
  const server = createServer((_request, response) => {
    response.writeHead(removed ? 404 : 200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        Config: { Labels: managed ? { 'com.mcp.role': 'updater' } : {} },
        State: { Status: status, Running: status === 'running', ExitCode: code },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const env = { MCP_DOCKER_SOCKET: socket };
  try {
    assert.deepEqual(await getUpdateTaskStatus(id, env), { status: 'running' });
    status = 'exited';
    code = 1;
    assert.deepEqual(await getUpdateTaskStatus(id, env), { status: 'failed' });
    code = 0;
    assert.deepEqual(await getUpdateTaskStatus(id, env), { status: 'succeeded' });
    managed = false;
    await assert.rejects(getUpdateTaskStatus(id, env), /invalid_update_task/);
    removed = true;
    assert.deepEqual(await getUpdateTaskStatus(id, env), { status: 'missing' });
    await assert.rejects(getUpdateTaskStatus('../other', env), /invalid_update_task/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
