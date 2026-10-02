import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextReleaseTag, prepareRelease, prepareVersionCommit, publishRelease, writeBackVersion } from './github-release.mjs';

test('automatic releases use stable semantic versions and conventional commit changes', () => {
  assert.equal(nextReleaseTag([], [], ['feat: first version']), 'v0.1.0');
  assert.equal(nextReleaseTag(['v0.2.8', 'v0.10.0', 'v9.0.0-beta.1', 'invalid'], [], ['fix: route']), 'v0.10.1');
  assert.equal(nextReleaseTag(['v0.2.8'], [], ['feat(servers): edit routes']), 'v0.3.0');
  assert.equal(nextReleaseTag(['v1.2.3'], [], ['feat(api)!: new contract']), 'v2.0.0');
  assert.equal(nextReleaseTag(['v1.2.3'], [], ['fix: schema\n\nBREAKING CHANGE: changed schema']), 'v2.0.0');
  assert.equal(nextReleaseTag(['v1.2.3'], ['v1.2.3'], ['feat: retry']), 'v1.2.3');
});

test('version commit synchronizes product manifests, preserves fixtures and is reused on retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-version-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const manifest = (file: string, name: string) => {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), `${JSON.stringify({ name, version: '0.1.0', private: true, dependencies: { '@mcp/shared': 'workspace:*' } }, null, 2)}\n`);
  };
  try {
    git('init'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'test@example.test');
    manifest('package.json', 'mcp-gateway'); manifest('packages/gateway/package.json', '@mcp/gateway');
    manifest('packages/shared/package.json', '@mcp/shared'); manifest('tests/fixtures/package.json', '@mcp/test-upstream');
    git('add', '.'); git('commit', '-m', 'feat: initial'); git('tag', 'v0.1.0');
    writeFileSync(join(directory, 'fix.txt'), 'fix'); git('add', '.'); git('commit', '-m', 'fix: release write-back');
    const base = git('rev-parse', 'HEAD');
    const release = prepareVersionCommit(directory);
    assert.equal(release.tag, 'v0.1.1'); assert.notEqual(release.sha, base);
    assert.equal(release.short_sha, release.sha.slice(0, 12));
    assert.equal(git('rev-parse', 'HEAD^'), base);
    assert.equal(git('log', '-1', '--format=%an <%ae>'), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
    assert.equal(git('log', '-1', '--format=%s'), 'chore(release): v0.1.1 [skip ci]');
    for (const file of ['package.json', 'packages/gateway/package.json', 'packages/shared/package.json']) {
      const saved = JSON.parse(git('show', `${release.sha}:${file}`));
      assert.equal(saved.version, '0.1.1'); assert.equal(saved.dependencies['@mcp/shared'], 'workspace:*');
    }
    assert.equal(JSON.parse(readFileSync(join(directory, 'tests/fixtures/package.json'), 'utf8')).version, '0.1.0');
    assert.equal(git('status', '--porcelain'), '');
    assert.deepEqual(prepareVersionCommit(directory), release);
    git('tag', release.tag);
    assert.deepEqual(prepareVersionCommit(directory), release);
    writeFileSync(join(directory, 'untracked.txt'), 'keep');
    assert.throws(() => prepareVersionCommit(directory), /clean working tree/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('version write-back rejects concurrent main commits and never overwrites their changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-writeback-'));
  const remote = join(directory, 'remote.git'), first = join(directory, 'first'), second = join(directory, 'second');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(directory, 'init', '--bare', '--initial-branch=main', remote);
    git(directory, 'clone', remote, first);
    git(first, 'config', 'user.name', 'Release test'); git(first, 'config', 'user.email', 'test@example.test');
    mkdirSync(join(first, 'packages/shared'), { recursive: true });
    writeFileSync(join(first, 'package.json'), '{"name":"mcp-gateway","version":"0.1.0"}\n');
    writeFileSync(join(first, 'packages/shared/package.json'), '{"name":"@mcp/shared","version":"0.1.0"}\n');
    git(first, 'add', '.'); git(first, 'commit', '-m', 'feat: initial'); git(first, 'tag', 'v0.1.0');
    writeFileSync(join(first, 'fix.txt'), 'fix'); git(first, 'add', '.'); git(first, 'commit', '-m', 'fix: version');
    git(first, 'push', 'origin', 'main');
    const release = prepareVersionCommit(first);
    writeBackVersion(release.sha, first);
    assert.equal(git(remote, 'rev-parse', 'main'), release.sha);
    writeBackVersion(release.sha, first); // Retrying an accepted push is harmless.
    git(directory, 'clone', remote, second);
    git(second, 'config', 'user.name', 'New contributor'); git(second, 'config', 'user.email', 'new@example.test');
    writeFileSync(join(second, 'new.txt'), 'retain concurrent work');
    git(second, 'add', '.'); git(second, 'commit', '-m', 'feat: concurrent change'); git(second, 'push', 'origin', 'main');
    const concurrent = git(second, 'rev-parse', 'HEAD');
    assert.throws(() => writeBackVersion(release.sha, first));
    assert.equal(git(remote, 'rev-parse', 'main'), concurrent);
    assert.equal(git(remote, 'show', 'main:new.txt'), 'retain concurrent work');
    assert.throws(() => writeBackVersion('a'.repeat(40), first), /prepared release commit/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('version preparation refuses to change an already published tag', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-immutable-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'test@example.test');
    mkdirSync(join(directory, 'packages/shared'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{"name":"mcp-gateway","version":"0.0.0"}\n');
    writeFileSync(join(directory, 'packages/shared/package.json'), '{"name":"@mcp/shared","version":"0.0.0"}\n');
    git('add', '.'); git('commit', '-m', 'feat: initial'); git('tag', 'v0.1.0');
    assert.throws(() => prepareVersionCommit(directory), /refusing to change its commit/);
    assert.equal(git('status', '--porcelain'), '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('version preparation reads real Git history and reuses an existing tag on rerun', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-release-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(join(directory, 'version.txt'), 'initial'); git('add', '.'); git('commit', '-m', 'feat: initial');
    assert.equal(prepareRelease(directory).tag, 'v0.1.0');
    git('tag', 'v0.1.0');
    writeFileSync(join(directory, 'version.txt'), 'route editor'); git('add', '.'); git('commit', '-m', 'feat(servers): route editor');
    const next = prepareRelease(directory);
    assert.equal(next.tag, 'v0.2.0');
    assert.equal(next.sha, git('rev-parse', 'HEAD'));
    git('tag', '-a', next.tag, '-m', 'Release');
    assert.deepEqual(prepareRelease(directory), next);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const options = { repository: 'owner/repo', token: 'test-token', tag: 'v0.1.0', sha: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('bot release records the tested commit, annotated tag and published image digest', async () => {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-token');
    const path = new URL(url).pathname.replace('/repos/owner/repo/', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init.method!, body });
    if (init.method === 'GET') return json({}, 404);
    if (path === 'git/tags') return json({ sha: 'c'.repeat(40) }, 201);
    if (path === 'git/refs') return json({}, 201);
    if (path === 'releases/generate-notes') return json({ body: 'Changes since last version.' });
    if (path === 'releases') return json({ html_url: 'https://github.com/owner/repo/releases/tag/v0.1.0', tag_name: options.tag }, 201);
    assert.fail(path);
  };
  await publishRelease({ ...options, fetchImpl });
  assert.equal(calls.find(call => call.path === 'git/tags')!.body.object, options.sha);
  assert.equal(calls.find(call => call.path === 'git/tags')!.body.tagger.name, 'github-actions[bot]');
  const release = calls.find(call => call.path === 'releases')!.body;
  assert.equal(release.target_commitish, options.sha);
  assert.equal(release.draft, false);
  assert.match(release.body, new RegExp(options.digest));
  assert.match(release.body, /mcp-gateway:v0\.1\.0/);
});

test('release retry is idempotent and never moves an existing tag to another commit', async () => {
  let writes = 0;
  const fetchImpl = async (url: string, init: RequestInit) => {
    if (init.method !== 'GET') writes++;
    const path = new URL(url).pathname;
    if (path.includes('/git/ref/')) return json({ object: { type: 'tag', sha: 'c'.repeat(40) } });
    if (path.includes('/git/tags/')) return json({ object: { type: 'commit', sha: options.sha } });
    return json({ draft: false, html_url: 'https://github.com/owner/repo/releases/tag/v0.1.0' });
  };
  await publishRelease({ ...options, fetchImpl });
  assert.equal(writes, 0);
  await assert.rejects(publishRelease({ ...options, sha: 'd'.repeat(40), fetchImpl }), /another commit/);
  assert.equal(writes, 0);
  await assert.rejects(publishRelease({ ...options, digest: '', fetchImpl }), /published image digest/);
  await assert.rejects(publishRelease({ ...options, fetchImpl: async () => json({}, 403) }), /HTTP 403/);
});
