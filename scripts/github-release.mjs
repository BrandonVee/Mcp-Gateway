import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parts = tag => versionPattern.exec(tag)?.slice(1).map(Number);
const compare = (a, b) => {
  const left = parts(a), right = parts(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

export function nextReleaseTag(tags, headTags, commits) {
  const stable = tags.filter(tag => parts(tag)?.every(Number.isSafeInteger)).sort(compare);
  const current = headTags.filter(tag => stable.includes(tag)).sort(compare).at(-1);
  if (current) return current;
  const previous = stable.at(-1);
  if (!previous) return 'v0.1.0';
  let [major, minor, patch] = parts(previous);
  if (commits.some(message => /^(?:\w+)(?:\([^\n)]*\))?!:|^BREAKING[ -]CHANGE:/m.test(message))) {
    major++; minor = 0; patch = 0;
  } else if (commits.some(message => /^feat(?:\([^\n)]*\))?:/m.test(message))) {
    minor++; patch = 0;
  } else patch++;
  return `v${major}.${minor}.${patch}`;
}

export function prepareRelease(cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tags = git(['tag', '--list', 'v*']).split('\n').filter(tag => parts(tag)?.every(Number.isSafeInteger));
  const previous = [...tags].sort(compare).at(-1);
  const sha = git(['rev-parse', 'HEAD']);
  const commits = git(['log', ...(previous ? [`${previous}..HEAD`] : []), '--format=%B%x00']).split('\0');
  const tag = nextReleaseTag(tags, git(['tag', '--points-at', sha]).split('\n'), commits);
  return { tag, version: tag.slice(1), sha };
}

export function versionCommitForSource(sha, source, cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (git(['rev-parse', `${sha}^`]) !== source) return undefined;
    if (git(['show', '-s', '--format=%ae', sha]) !== '41898282+github-actions[bot]@users.noreply.github.com') return undefined;
    const tag = /^chore\(release\): (v\d+\.\d+\.\d+) \[skip ci\]$/.exec(git(['show', '-s', '--format=%s', sha]))?.[1];
    if (!versionPattern.test(tag ?? '')) return undefined;
    const files = git(['diff', '--name-only', source, sha]).split('\n');
    if (!files.length || files.some(file => file !== 'package.json' && !/^packages\/[^/]+\/package\.json$/.test(file))) return undefined;
    // A retry may adopt a bot commit only if it changed version metadata alone.
    for (const file of files) {
      const before = JSON.parse(git(['show', `${source}:${file}`])), after = JSON.parse(git(['show', `${sha}:${file}`]));
      if (after.version !== tag.slice(1)) return undefined;
      delete before.version; delete after.version;
      if (JSON.stringify(before) !== JSON.stringify(after)) return undefined;
    }
    return { tag, version: tag.slice(1), sha, short_sha: sha.slice(0, 12) };
  } catch { return undefined; }
}

export function existingReleaseCandidate(cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const source = git(['rev-parse', 'HEAD']);
  const tags = git(['tag', '--list', 'v*']).split('\n').filter(tag => parts(tag)?.every(Number.isSafeInteger)).sort(compare).reverse();
  for (const tag of tags) {
    const sha = git(['rev-parse', `${tag}^{commit}`]);
    if (sha === source) return { tag, version: tag.slice(1), sha, short_sha: sha.slice(0, 12) };
    const bot = versionCommitForSource(sha, source, cwd);
    if (bot?.tag === tag) return bot;
  }
}

function releaseApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Release requires a valid repository and GitHub token');
  return async (path, method = 'GET', body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

async function assertTagCommit(api, tag, sha) {
  const ref = await api(`git/ref/tags/${tag}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = (await api(`git/tags/${object.sha}`)).object;
  if (object.type !== 'commit' || object.sha !== sha) throw new Error(`Existing ${tag} points at another commit; refusing to move it`);
  return ref;
}

const recordedDigest = release => /Digest:\s*`?(sha256:[a-f\d]{64})\b/.exec(release.body ?? '')?.[1];

export async function publishedReleaseForCommit(options) {
  if (!versionPattern.test(options.tag) || !/^[a-f\d]{40}$/.test(options.sha)) throw new Error('Invalid release tag or commit');
  const api = releaseApi(options);
  const release = await api(`releases/tags/${options.tag}`);
  if (!release || release.draft) return undefined;
  if (!await assertTagCommit(api, options.tag, options.sha)) throw new Error(`Published ${options.tag} has no matching Git tag`);
  const digest = recordedDigest(release);
  if (!digest) throw new Error(`Published ${options.tag} has no recorded image digest; refusing to overwrite its image`);
  return { released: 'true', digest, release_url: release.html_url };
}

export function prepareVersionCommit(cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain'])) throw new Error('Version preparation requires a clean working tree');
  const release = prepareRelease(cwd);
  const files = ['package.json', ...readdirSync(join(cwd, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/package.json`)];
  // Read every manifest before writing, so malformed files leave the checkout intact.
  const updates = files.map(file => {
    const original = readFileSync(join(cwd, file), 'utf8');
    const manifest = JSON.parse(original);
    return { file, original, content: `${JSON.stringify({ ...manifest, version: release.version }, null, 2)}\n` };
  }).filter(update => update.content !== update.original);
  if (updates.length) {
    if (git(['tag', '--points-at', release.sha]).split('\n').includes(release.tag)) {
      throw new Error(`Published ${release.tag} has different manifest versions; refusing to change its commit`);
    }
    for (const update of updates) writeFileSync(join(cwd, update.file), update.content);
    git(['add', '--', ...updates.map(update => update.file)]);
    git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', `chore(release): ${release.tag} [skip ci]`]);
  }
  const sha = git(['rev-parse', 'HEAD']);
  return { ...release, sha, short_sha: sha.slice(0, 12) };
}

export function writeBackVersion(sha, cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^[a-f\d]{40}$/.test(sha) || git(['rev-parse', 'HEAD']) !== sha || git(['status', '--porcelain'])) {
    throw new Error('Version write-back requires the clean, prepared release commit');
  }
  // A normal fast-forward push rejects concurrent changes; never force-push main.
  git(['push', 'origin', `${sha}:refs/heads/main`]);
}

export async function publishRelease({ repository, token, tag, sha, digest, makeLatest = 'legacy', apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !versionPattern.test(tag) || !/^[a-f\d]{40}$/.test(sha)) throw new Error('Invalid release repository, tag, or commit');
  if (!token || !/^sha256:[a-f\d]{64}$/.test(digest)) throw new Error('Release requires a GitHub token and a published image digest');
  if (!['true', 'false', 'legacy'].includes(makeLatest)) throw new Error('Invalid latest release policy');
  const api = releaseApi({ repository, token, apiUrl, fetchImpl });
  // Published releases must be checked before creating any Git objects. A
  // deleted tag is an integrity failure, not permission to recreate it.
  const existing = await api(`releases/tags/${tag}`);
  const ref = await assertTagCommit(api, tag, sha);
  if (existing && !existing.draft) {
    if (!ref) throw new Error(`Published ${tag} has no matching Git tag; refusing to recreate it`);
    if (recordedDigest(existing) !== digest) throw new Error(`Published ${tag} has a different image digest; refusing to rewrite the release`);
    return existing;
  }
  const latest = await api('releases/latest');
  if (parts(latest?.tag_name)?.every(Number.isSafeInteger) && compare(tag, latest.tag_name) < 0) makeLatest = 'false';
  if (!ref) {
    const annotated = await api('git/tags', 'POST', {
      tag, message: `Release ${tag}`, object: sha, type: 'commit',
      tagger: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', date: new Date().toISOString() },
    });
    await api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: annotated.sha });
  }
  const notes = await api('releases/generate-notes', 'POST', { tag_name: tag, target_commitish: sha });
  const body = `${notes.body}\n\n### Docker image\n\n` +
    `\`brandonvee/mcp-gateway:${tag}\` (linux/amd64, linux/arm64)\n\n` +
    `Digest: \`${digest}\`\n\n` +
    `\`MCP_IMAGE_PREFIX=brandonvee/ MCP_IMAGE_NAME=mcp-gateway MCP_VERSION=${tag} ./scripts/deploy.sh --yes\`\n`;
  const payload = { tag_name: tag, target_commitish: sha, name: tag, body, draft: false, prerelease: false, make_latest: makeLatest };
  return existing ? api(`releases/${existing.id}`, 'PATCH', payload) : api('releases', 'POST', payload);
}

async function main() {
  if (process.argv[2] === 'prepare') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
    if (git(['status', '--porcelain'])) throw new Error('Version preparation requires a clean working tree');
    const apiOptions = { repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL };
    const manualTag = process.env.GITHUB_REF?.startsWith('refs/tags/') ? process.env.GITHUB_REF.slice('refs/tags/'.length) : undefined;
    let candidate = manualTag ? { tag: manualTag, sha: git(['rev-parse', 'HEAD']), version: manualTag.slice(1), short_sha: git(['rev-parse', 'HEAD']).slice(0, 12) }
      : existingReleaseCandidate();
    let published = candidate ? await publishedReleaseForCommit({ ...apiOptions, ...candidate }) : undefined;
    let release;
    if (published) release = { ...candidate, ...published };
    else if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
      const tag = process.env.GITHUB_REF.slice('refs/tags/'.length), sha = git(['rev-parse', 'HEAD']);
      if (!versionPattern.test(tag) || git(['rev-parse', `${tag}^{commit}`]) !== sha) throw new Error('Manual releases require a stable tag at HEAD');
      const files = ['package.json', ...readdirSync('packages', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/package.json`)];
      if (files.some(file => JSON.parse(readFileSync(file, 'utf8')).version !== tag.slice(1))) throw new Error('Manual tag and product manifest versions must match');
      release = { tag, version: tag.slice(1), sha, short_sha: sha.slice(0, 12), released: 'false' };
    } else {
      const remote = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], head = git(['rev-parse', 'HEAD']);
      if (remote !== head) {
        // Resume a bot-only write-back after a failed tag/Release API request.
        git(['fetch', 'origin', 'main']);
        candidate = versionCommitForSource(remote, head);
        if (!candidate) throw new Error('main advanced since this workflow started; release the latest main instead');
        published = await publishedReleaseForCommit({ ...apiOptions, ...candidate });
        if (!published) git(['checkout', '--detach', remote]);
      }
      release = published ? { ...candidate, ...published } : { ...prepareVersionCommit(), released: 'false' };
    }
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(release).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`${release.released === 'true' ? 'Already published; preserving' : 'Selected'} ${release.tag} for ${release.sha}`);
    if (published && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n### Existing release preserved\n\n[${release.tag}](${release.release_url}) — image digest \`${release.digest}\`; no image rebuild or tag overwrite.\n`);
  } else if (process.argv[2] === 'write-back') {
    writeBackVersion(process.env.RELEASE_SHA);
    console.log(`Version commit ${process.env.RELEASE_SHA} written back to main`);
  } else if (process.argv[2] === 'publish') {
    const release = await publishRelease({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
      tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA, digest: process.env.IMAGE_DIGEST,
      makeLatest: process.env.GITHUB_REF === 'refs/heads/main' ? 'true' : 'legacy', apiUrl: process.env.GITHUB_API_URL });
    console.log(`Published ${release.html_url}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### GitHub Release\n\n[${release.tag_name}](${release.html_url})\n`);
  } else throw new Error('Usage: node scripts/github-release.mjs prepare|write-back|publish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
