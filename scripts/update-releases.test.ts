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
  createReleaseCatalog,
  createReleaseDispatcher,
  ReleaseLookupError,
  releaseFailureReason,
} from '@/auth/modules/system/releases';
import { getUpdateStatus, getUpdateTaskStatus, startUpdate } from '@/auth/modules/system/update-service';
import { officialUpdateImage, runningVersion } from '@/auth/modules/system/update-identity';

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
    const runtimeStatus = await getUpdateStatus(env, false, true);
    assert.equal(runtimeStatus.container_id, 'old');
    assert.equal(checks, 0, 'replacement polls must not wait for internet metadata');
    const status = await getUpdateStatus(env);
    assert.equal(status.version, '0.5.2');
    assert.equal(status.container_ready, true);
    assert.equal(status.latest_version, '0.5.3');
    assert.equal(status.update_available, true);
    assert.equal(status.release_check_error, false);
    await getUpdateStatus(env);
    assert.equal(checks, 3);
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
  assert.equal(calls.length, 3);
  assert.match(calls[1], /^https:\/\/hub\.docker\.com\//);
  assert.deepEqual(
    releases.map((release) => release.tag),
    ['v0.5.3'],
  );
  assert.equal(runningVersion({ RepoDigests: [`brandonvee/mcp-gateway@${oldDigest}`] }, releases), '0.5.3');
  assert.throws(() => parseImageTags({ results: null }));
  await assert.rejects(
    fetchPublishedReleases(async () => new Response('{}', { status: 429 })),
    (error: unknown) =>
      error instanceof ReleaseLookupError &&
      error.failures.length === 3 &&
      error.failures.every((failure) => failure.reason === 'rate_limited' && failure.http_status === 429),
  );
  await assert.rejects(
    fetchPublishedReleases(async () => {
      throw new Error('network unavailable');
    }),
    (error: unknown) =>
      error instanceof ReleaseLookupError &&
      error.failures.length === 3 &&
      error.failures.every((failure) => failure.reason === 'network'),
  );
});

test('private GitHub and timed-out Hub API fall back to sorted, digest-pinned registry releases', async () => {
  const registry = 'https://registry-1.docker.io/v2/brandonvee/mcp-gateway';
  const calls: string[] = [];
  const signals = new Set<AbortSignal>();
  const releases = await fetchPublishedReleases(async (input, init) => {
    const url = String(input);
    calls.push(url);
    const headers = new Headers(init?.headers);
    assert.equal(init?.redirect, 'error');
    if (!url.startsWith(registry)) assert.equal(headers.has('Authorization'), false);
    if (url.includes('api.github.com')) return new Response('{}', { status: 404 });
    if (url.includes('hub.docker.com')) throw new DOMException('timed out', 'TimeoutError');
    signals.add(init!.signal!);
    if (url.startsWith('https://auth.docker.io/token?')) return Response.json({ token: 'public-pull-token' });
    assert.equal(headers.get('Authorization'), 'Bearer public-pull-token');
    if (url === `${registry}/tags/list?n=1000`)
      return Response.json(
        { tags: ['latest', 'v0.9.0', 'v0.14.0-beta', '0.15.0', 'v01.2.3'] },
        { headers: { Link: '<https://untrusted.example/tags>; rel="next"' } },
      );
    if (url === `${registry}/tags/list?n=1000&last=v01.2.3`)
      return Response.json({ tags: ['v0.14.0', 'v0.9.0', 'v0.13.3'] });
    assert.equal(init?.method, 'HEAD');
    assert.match(headers.get('Accept')!, /application\/vnd\.oci\.image\.index\.v1\+json/);
    assert.match(url, /\/manifests\/v0\.(9\.0|13\.3|14\.0)$/);
    return new Response(null, {
      headers: {
        'Docker-Content-Digest': url.endsWith('v0.14.0') ? digest : oldDigest,
        'Content-Type': 'application/vnd.oci.image.index.v1+json',
      },
    });
  });
  assert.deepEqual(releases, [
    { tag: 'v0.14.0', version: '0.14.0', digest },
    { tag: 'v0.13.3', version: '0.13.3', digest: oldDigest },
    { tag: 'v0.9.0', version: '0.9.0', digest: oldDigest },
  ]);
  assert.equal(calls.length, 8);
  assert.equal(signals.size, 1, 'the entire registry lookup shares one deadline and cancellation signal');
  assert.equal([...signals][0].aborted, true);
});

test('registry fallback bounds manifest lookups to the newest 20 stable versions', async () => {
  const manifests: string[] = [];
  const releases = await fetchPublishedReleases(async (input) => {
    const url = String(input);
    if (url.includes('api.github.com') || url.includes('hub.docker.com')) return new Response('{}', { status: 404 });
    if (url.includes('auth.docker.io')) return Response.json({ token: 'public-pull-token' });
    if (url.includes('/tags/list')) return Response.json({ tags: Array.from({ length: 25 }, (_, i) => `v0.${i}.0`) });
    manifests.push(url);
    return new Response(null, {
      headers: {
        'Docker-Content-Digest': digest,
        'Content-Type': 'application/vnd.docker.distribution.manifest.list.v2+json',
      },
    });
  });
  assert.equal(manifests.length, 20);
  assert.equal(releases.length, 20);
  assert.equal(releases[0].version, '0.24.0');
  assert.equal(releases.at(-1)?.version, '0.5.0');
});

test('registry fallback rejects invalid metadata and preserves safe HTTP failure details', async (t) => {
  for (const scenario of ['token', 'tags', 'empty', 'pagination', 'digest', 'type', 'rate_limit']) {
    await t.test(scenario, async () => {
      await assert.rejects(
        fetchPublishedReleases(async (input) => {
          const url = String(input);
          if (url.includes('api.github.com') || url.includes('hub.docker.com'))
            return new Response('{}', { status: 404 });
          if (url.includes('auth.docker.io')) return Response.json({ token: scenario === 'token' ? null : 'secret' });
          if (url.includes('/tags/list'))
            return Response.json(
              { tags: scenario === 'tags' ? [null] : scenario === 'empty' ? ['latest'] : ['v0.14.0'] },
              { headers: scenario === 'pagination' ? { Link: '</tags>; rel="next"' } : {} },
            );
          return new Response(null, {
            status: scenario === 'rate_limit' ? 429 : 200,
            headers: {
              'Docker-Content-Digest': scenario === 'digest' ? 'invalid' : digest,
              'Content-Type': scenario === 'type' ? 'application/json' : 'application/vnd.oci.image.index.v1+json',
            },
          });
        }),
        (error: unknown) => {
          assert.ok(error instanceof ReleaseLookupError);
          assert.deepEqual(error.failures, [
            { source: 'github', reason: 'http', http_status: 404 },
            { source: 'dockerhub', reason: 'http', http_status: 404 },
            {
              source: 'docker_registry',
              reason: scenario === 'rate_limit' ? 'rate_limited' : 'invalid_response',
              ...(scenario === 'rate_limit' ? { http_status: 429 } : {}),
            },
          ]);
          return true;
        },
      );
    });
  }
});

test('a successful Hub catalog cancels a pending registry request', async () => {
  let cancelled = false;
  const releases = await fetchPublishedReleases(async (input, init) => {
    const url = String(input);
    if (url.includes('api.github.com')) return new Response('{}', { status: 404 });
    if (url.includes('hub.docker.com'))
      return Response.json({ results: [{ name: 'v0.14.0', tag_status: 'active', digest }] });
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => {
        cancelled = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  });
  assert.equal(releases[0].version, '0.14.0');
  assert.equal(cancelled, true);
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

test('a slow or unreachable source cannot delay the other successful catalog', async () => {
  const releases = await fetchPublishedReleases(async (url, init) => {
    if (String(url).includes('api.github.com'))
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled'))),
      );
    return new Response(JSON.stringify({ results: [{ name: 'v0.5.4', tag_status: 'active', digest }] }));
  });
  assert.equal(releases[0].version, '0.5.4');
});

test('manual checks bypass failure cooldown and failed checks keep cached data explicitly stale', async () => {
  let time = 100_000,
    calls = 0,
    failing = false;
  const failure = new ReleaseLookupError([{ source: 'dockerhub', reason: 'dns' }]);
  const catalog = createReleaseCatalog(
    async () => {
      calls++;
      if (failing) throw failure;
      return parseReleases([release('v0.5.4')]);
    },
    () => time,
  );
  assert.equal((await catalog()).error, false);
  await catalog();
  assert.equal(calls, 1);
  failing = true;
  const stale = await catalog(true);
  assert.equal(stale.error, true);
  assert.equal(stale.releases[0].version, '0.5.4');
  assert.deepEqual(stale.failures, failure.failures);
  await catalog();
  assert.equal(calls, 2);
  failing = false;
  assert.equal((await catalog(true)).error, false);
  assert.equal(calls, 3);
  failing = true;
  await catalog(true);
  time += 30_001;
  assert.equal((await catalog()).error, true);
  assert.equal(calls, 5, 'failed manual checks must not revert to a fresh cache after cooldown');
});

test('failure categories preserve useful causes without returning exception text or proxy credentials', () => {
  assert.equal(releaseFailureReason(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assert.equal(releaseFailureReason(new Error('fetch failed', { cause: { code: 'ENOTFOUND' } })), 'dns');
  assert.equal(releaseFailureReason(new Error('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } })), 'tls');
  assert.equal(
    releaseFailureReason({ cause: { errors: [{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }] } }),
    'timeout',
  );
  assert.equal(releaseFailureReason(new Error('secret proxy credentials')), 'network');
});

test('version request transport honors configured HTTP proxy and NO_PROXY without changing global requests', async () => {
  let tunneled = 0;
  const proxy = createServer((_request, response) => response.writeHead(500).end());
  proxy.on('connect', (request, socket) => {
    tunneled++;
    assert.equal(request.url, 'catalog.example.test:80');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () =>
      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{"via":"proxy"} ',
      ),
    );
  });
  const direct = createServer((_request, response) => response.end('direct'));
  await Promise.all([
    new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => direct.listen(0, '127.0.0.1', resolve)),
  ]);
  const proxyPort = (proxy.address() as { port: number }).port;
  const directPort = (direct.address() as { port: number }).port;
  const transport = createReleaseDispatcher({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1' });
  try {
    const proxied = await fetch('http://catalog.example.test/releases', { dispatcher: transport } as RequestInit);
    assert.deepEqual(await proxied.json(), { via: 'proxy' });
    const bypassed = await fetch(`http://127.0.0.1:${directPort}/releases`, { dispatcher: transport } as RequestInit);
    assert.equal(await bypassed.text(), 'direct');
    assert.equal(tunneled, 1);
  } finally {
    await transport.close();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => direct.close(() => resolve())),
    ]);
  }
});

test('invalid proxy schemes are rejected without exposing credentials', () => {
  assert.throws(
    () => createReleaseDispatcher({ HTTPS_PROXY: 'socks5://user:secret@127.0.0.1:1080' }),
    /^Error: invalid_release_proxy$/,
  );
});

test('response-body connection failures remain network failures rather than invalid version metadata', async () => {
  await assert.rejects(
    fetchPublishedReleases(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('body lost', { cause: { code: 'ECONNRESET' } });
          },
        }) as Response,
    ),
    (error: unknown) =>
      error instanceof ReleaseLookupError && error.failures.every((failure) => failure.reason === 'network'),
  );
});
