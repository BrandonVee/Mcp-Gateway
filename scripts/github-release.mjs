// Release tooling: keep this script dependency-free. The release workflow copies
// it out of the workspace and runs it from a bare checkout, with no install step
// and no node_modules to resolve imports from.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parts = (tag) => versionPattern.exec(tag)?.slice(1).map(Number);
const compare = (a, b) => {
  const left = parts(a),
    right = parts(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};
const versionSubject = /^chore\(release\): v\d+\.\d+\.\d+ \[skip ci\]$/;

export function nextReleaseTag(tags, headTags, commits) {
  const stable = tags.filter((tag) => parts(tag)?.every(Number.isSafeInteger)).sort(compare);
  const current = headTags
    .filter((tag) => stable.includes(tag))
    .sort(compare)
    .at(-1);
  if (current) return current;
  const previous = stable.at(-1);
  if (!previous) return 'v0.1.0';
  let [major, minor, patch] = parts(previous);
  if (commits.some((message) => /^(?:\w+)(?:\([^\n)]*\))?!:|^BREAKING[ -]CHANGE:/m.test(message))) {
    major++;
    minor = 0;
    patch = 0;
  } else if (commits.some((message) => /^feat(?:\([^\n)]*\))?:/m.test(message))) {
    minor++;
    patch = 0;
  } else patch++;
  return `v${major}.${minor}.${patch}`;
}

const noteGroups = [
  ['### Features', /^feat(?:\([^\n)]*\))?!?:/],
  ['### Bug Fixes', /^(?:fix|perf)(?:\([^\n)]*\))?!?:/],
  ['### Other Changes', null],
];

/**
 * Build "What's Changed" markdown from `git log --pretty=format:%s%x00%h`
 * output. Direct pushes to main never become pull requests, so the GitHub
 * generate-notes API has nothing to list; the commit log is the source of
 * truth here. Release version commits are excluded. Returns null when no
 * noteworthy commit exists.
 */
export function formatCommitNotes(logText, { repository, tag, previousTag }) {
  const buckets = new Map(noteGroups.map(([title]) => [title, []]));
  for (const line of logText.split('\n')) {
    const [subject, hash] = line.split('\x00');
    if (!subject || versionSubject.test(subject)) continue;
    const [title] = noteGroups.find(([, pattern]) => pattern === null || pattern.test(subject));
    buckets.get(title).push(`* ${subject}${hash ? ` (\`${hash.slice(0, 7)}\`)` : ''}`);
  }
  const sections = [...buckets]
    .filter(([, items]) => items.length)
    .map(([title, items]) => `${title}\n\n${items.join('\n')}`);
  if (!sections.length) return null;
  const link = previousTag
    ? `\n\n**Full Changelog**: https://github.com/${repository}/compare/${previousTag}...${tag}`
    : '';
  return sections.join('\n\n') + link;
}

/** Commit-log release notes; null when history is unavailable (shallow tests). */
function commitLogNotes({ repository, tag, sha, cwd = process.cwd() }) {
  try {
    const git = (args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const previousTag = git(['tag', '--merged', sha, '--sort=-v:refname', '--list', 'v*'])
      .split('\n')
      .filter((candidate) => versionPattern.test(candidate) && candidate !== tag)[0];
    const log = git(
      previousTag
        ? ['log', '--no-merges', '--pretty=format:%s%x00%h', `${previousTag}..${sha}`]
        : ['log', '--no-merges', '-50', '--pretty=format:%s%x00%h', sha],
    );
    return formatCommitNotes(log, { repository, tag, previousTag });
  } catch {
    return null;
  }
}

export function prepareRelease(cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .filter((tag) => parts(tag)?.every(Number.isSafeInteger));
  const previous = [...tags].sort(compare).at(-1);
  const sha = git(['rev-parse', 'HEAD']);
  // The bot writes the released version back after publishing; it must not
  // become the next version's only change.
  const commits = git(['log', ...(previous ? [`${previous}..HEAD`] : []), '--format=%B%x00'])
    .split('\0')
    .filter((message) => !versionSubject.test(message.trim().split('\n')[0]));
  const tag = nextReleaseTag(tags, git(['tag', '--points-at', sha]).split('\n'), commits);
  return { tag, version: tag.slice(1), sha, short_sha: sha.slice(0, 12) };
}

export function versionCommitForSource(sha, source, cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (git(['rev-parse', `${sha}^`]) !== source) return undefined;
    if (git(['show', '-s', '--format=%ae', sha]) !== '41898282+github-actions[bot]@users.noreply.github.com')
      return undefined;
    const tag = /^chore\(release\): (v\d+\.\d+\.\d+) \[skip ci\]$/.exec(git(['show', '-s', '--format=%s', sha]))?.[1];
    if (!versionPattern.test(tag ?? '')) return undefined;
    const files = git(['diff', '--name-only', source, sha]).split('\n');
    if (!files.length || files.some((file) => file !== 'package.json' && !/^packages\/[^/]+\/package.json$/.test(file)))
      return undefined;
    // A retry may adopt a bot commit only if it changed version metadata alone.
    for (const file of files) {
      const before = JSON.parse(git(['show', `${source}:${file}`])),
        after = JSON.parse(git(['show', `${sha}:${file}`]));
      if (after.version !== tag.slice(1)) return undefined;
      delete before.version;
      delete after.version;
      if (JSON.stringify(before) !== JSON.stringify(after)) return undefined;
    }
    return { tag, version: tag.slice(1), sha, short_sha: sha.slice(0, 12) };
  } catch {
    return undefined;
  }
}

export function existingReleaseCandidate(cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const source = git(['rev-parse', 'HEAD']);
  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .filter((tag) => parts(tag)?.every(Number.isSafeInteger))
    .sort(compare)
    .reverse();
  for (const tag of tags) {
    const sha = git(['rev-parse', `${tag}^{commit}`]);
    if (sha === source) return { tag, version: tag.slice(1), sha, short_sha: sha.slice(0, 12) };
    const bot = versionCommitForSource(sha, source, cwd);
    if (bot?.tag === tag) return bot;
  }
}

function releaseApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
    throw new Error('Release requires a valid repository and GitHub token');
  return async (path, method = 'GET', body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
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
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++)
    object = (await api(`git/tags/${object.sha}`)).object;
  if (object.type !== 'commit' || object.sha !== sha)
    throw new Error(`Existing ${tag} points at another commit; refusing to move it`);
  return ref;
}

const recordedDigest = (release) => /Digest:\s*`?(sha256:[a-f\d]{64})\b/.exec(release.body ?? '')?.[1];

export async function publishedReleaseForCommit(options) {
  if (!versionPattern.test(options.tag) || !/^[a-f\d]{40}$/.test(options.sha))
    throw new Error('Invalid release tag or commit');
  const api = releaseApi(options);
  const release = await api(`releases/tags/${options.tag}`);
  if (!release || release.draft) return undefined;
  if (!(await assertTagCommit(api, options.tag, options.sha)))
    throw new Error(`Published ${options.tag} has no matching Git tag`);
  const digest = recordedDigest(release);
  if (!digest)
    throw new Error(`Published ${options.tag} has no recorded image digest; refusing to overwrite its image`);
  return { released: 'true', digest, release_url: release.html_url };
}

/** Read-only: report the next version and whether it is already published. */
export async function planRelease({ cwd = process.cwd(), repository, token, apiUrl, fetchImpl = fetch }) {
  const candidate = existingReleaseCandidate(cwd) ?? prepareRelease(cwd);
  const published = await publishedReleaseForCommit({ repository, token, apiUrl, fetchImpl, ...candidate });
  return { ...candidate, released: published ? 'true' : 'false', ...published };
}

/** Read-only: resolve the commit a release publishes and whether it is the branch head. */
export async function resolveRelease({
  cwd = process.cwd(),
  repository,
  token,
  apiUrl,
  fetchImpl = fetch,
  tag,
  ref,
  branch = 'main',
}) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const requested = ref || tag;
  if (!requested) throw new Error('Release resolution requires a tag or commit');
  let sha;
  try {
    sha = git(['rev-parse', '--verify', `${requested}^{commit}`]);
  } catch {
    throw new Error(`Release resolution cannot resolve ${requested}`);
  }
  if (git(['rev-parse', 'HEAD']) !== sha) throw new Error('Release checkout must be at the requested commit');
  let resolved = tag && versionPattern.test(tag) ? tag : undefined;
  if (!resolved) {
    const pointed = git(['tag', '--points-at', sha])
      .split('\n')
      .filter((candidate) => versionPattern.test(candidate))
      .sort(compare);
    resolved = pointed.at(-1);
  }
  if (!resolved) throw new Error('manual releases need a tag at the published commit');
  const api = releaseApi({ repository, token, apiUrl, fetchImpl });
  const head = await api(`commits/${branch}`);
  const latest = head?.sha === sha ? 'true' : 'false';
  const published = await publishedReleaseForCommit({ repository, token, apiUrl, fetchImpl, tag: resolved, sha });
  return {
    tag: resolved,
    version: resolved.slice(1),
    sha,
    short_sha: sha.slice(0, 12),
    released: published ? 'true' : 'false',
    latest,
    ...published,
  };
}

export function commitVersion({ tag, cwd = process.cwd() }) {
  if (!versionPattern.test(tag)) throw new Error('Invalid release tag');
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain'])) throw new Error('Version preparation requires a clean working tree');
  const version = tag.slice(1);
  const files = [
    'package.json',
    ...readdirSync(join(cwd, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`),
  ];
  // Read every manifest before writing, so malformed files leave the checkout intact.
  const updates = files
    .map((file) => {
      const original = readFileSync(join(cwd, file), 'utf8');
      const manifest = JSON.parse(original);
      return { file, original, content: `${JSON.stringify({ ...manifest, version }, null, 2)}\n` };
    })
    .filter((update) => update.content !== update.original);
  const sha = git(['rev-parse', 'HEAD']);
  if (!updates.length) return { tag, version, sha, short_sha: sha.slice(0, 12), changed: false };
  // The released tag now points at the tested commit, whose manifests still carry
  // the previous version. Only a commit released as another version is off limits.
  const released = git(['tag', '--points-at', sha])
    .split('\n')
    .filter((candidate) => versionPattern.test(candidate) && candidate !== tag);
  if (released.length)
    throw new Error(`Commit ${sha} is already released as ${released.join(', ')}; refusing to write ${tag}`);
  for (const update of updates) writeFileSync(join(cwd, update.file), update.content);
  git(['add', '--', ...updates.map((update) => update.file)]);
  git([
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    `chore(release): ${tag} [skip ci]`,
  ]);
  const committed = git(['rev-parse', 'HEAD']);
  return { tag, version, sha: committed, short_sha: committed.slice(0, 12), changed: true };
}

export function pushVersionCommit({ sha, branch = 'main', remote = 'origin', cwd = process.cwd() }) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^[a-f\d]{40}$/.test(sha) || git(['rev-parse', 'HEAD']) !== sha || git(['status', '--porcelain'])) {
    throw new Error('Version write-back requires the clean, prepared release commit');
  }
  // A normal fast-forward push rejects concurrent changes; never force-push main.
  git(['push', remote, `${sha}:refs/heads/${branch}`]);
}

/** Write the released version back to the default branch after publishing. */
export function syncVersion({ tag, branch = 'main', remote = 'origin', cwd = process.cwd() }) {
  if (!versionPattern.test(tag)) throw new Error('Invalid release tag');
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['fetch', remote, branch]);
  const head = git(['rev-parse', `refs/remotes/${remote}/${branch}`]);
  const current = JSON.parse(git(['show', `${head}:package.json`])).version;
  if (parts(`v${current}`) && compare(`v${current}`, tag) >= 0) {
    // Re-publishing an older tag must never move the branch version backwards.
    return {
      tag,
      version: tag.slice(1),
      sha: head,
      short_sha: head.slice(0, 12),
      changed: false,
      skipped_reason: 'branch version is already current',
    };
  }
  git(['checkout', '--detach', head]);
  const release = commitVersion({ tag, cwd });
  if (!release.changed) return { ...release, skipped_reason: 'manifests already match the release' };
  pushVersionCommit({ sha: release.sha, branch, remote, cwd });
  return { ...release, changed: true };
}

export async function publishRelease({
  repository,
  token,
  tag,
  sha,
  digest,
  makeLatest = 'legacy',
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !versionPattern.test(tag) || !/^[a-f\d]{40}$/.test(sha))
    throw new Error('Invalid release repository, tag, or commit');
  if (!token || !/^sha256:[a-f\d]{64}$/.test(digest))
    throw new Error('Release requires a GitHub token and a published image digest');
  if (!['true', 'false', 'legacy'].includes(makeLatest)) throw new Error('Invalid latest release policy');
  const api = releaseApi({ repository, token, apiUrl, fetchImpl });
  // Published releases must be checked before creating any Git objects. A
  // deleted tag is an integrity failure, not permission to recreate it.
  const existing = await api(`releases/tags/${tag}`);
  const ref = await assertTagCommit(api, tag, sha);
  if (existing && !existing.draft) {
    if (!ref) throw new Error(`Published ${tag} has no matching Git tag; refusing to recreate it`);
    if (recordedDigest(existing) !== digest)
      throw new Error(`Published ${tag} has a different image digest; refusing to rewrite the release`);
    return existing;
  }
  const latest = await api('releases/latest');
  if (parts(latest?.tag_name)?.every(Number.isSafeInteger) && compare(tag, latest.tag_name) < 0) makeLatest = 'false';
  if (!ref) {
    const annotated = await api('git/tags', 'POST', {
      tag,
      message: `Release ${tag}`,
      object: sha,
      type: 'commit',
      tagger: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
        date: new Date().toISOString(),
      },
    });
    await api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: annotated.sha });
  }
  const notes =
    commitLogNotes({ repository, tag, sha }) ??
    (await api('releases/generate-notes', 'POST', { tag_name: tag, target_commitish: sha })).body;
  const body =
    `${notes.body}\n\n### Docker image\n\n` +
    `\`brandonvee/mcp-gateway:${tag}\` (linux/amd64, linux/arm64)\n\n` +
    `Digest: \`${digest}\`\n\n` +
    `\`MCP_VERSION=${tag} ./scripts/deploy.sh --yes\`\n`;
  const payload = {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    body,
    draft: false,
    prerelease: false,
    make_latest: makeLatest,
  };
  return existing ? api(`releases/${existing.id}`, 'PATCH', payload) : api('releases', 'POST', payload);
}

function emit(values) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  return values;
}

async function main() {
  const command = process.argv[2];
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (command === 'plan') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    if (git(['status', '--porcelain'])) throw new Error('Release planning requires a clean working tree');
    const release = await planRelease({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    emit(release);
    console.log(
      `${release.released === 'true' ? 'Already published; skipping' : 'Planned'} ${release.tag} for ${release.sha}`,
    );
    if (release.released === 'true' && process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### Existing release preserved\n\n[${release.tag}](${release.release_url}) — image digest \`${release.digest}\`; no image rebuild or tag overwrite.\n`,
      );
  } else if (command === 'resolve') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    const release = await resolveRelease({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
      tag: process.env.RELEASE_TAG,
      ref: process.env.RELEASE_REF,
      branch: process.env.RELEASE_BRANCH || 'main',
    });
    emit(release);
    console.log(`Resolved ${release.tag} at ${release.sha} (released: ${release.released}, latest: ${release.latest})`);
    if (release.released === 'true' && process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### Existing release preserved\n\n[${release.tag}](${release.release_url}) — image digest \`${release.digest}\`; no image rebuild or tag overwrite.\n`,
      );
  } else if (command === 'sync-version') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    const release = syncVersion({ tag: process.env.RELEASE_TAG, branch: process.env.RELEASE_BRANCH || 'main' });
    emit(release);
    console.log(
      release.changed
        ? `Version ${release.version} written back as ${release.sha}`
        : `Version write-back skipped: ${release.skipped_reason}`,
    );
  } else if (command === 'publish') {
    const release = await publishRelease({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      tag: process.env.RELEASE_TAG,
      sha: process.env.RELEASE_SHA,
      digest: process.env.IMAGE_DIGEST,
      makeLatest: process.env.MAKE_LATEST || 'legacy',
      apiUrl: process.env.GITHUB_API_URL,
    });
    console.log(`Published ${release.html_url}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### GitHub Release\n\n[${release.tag_name}](${release.html_url})\n`,
      );
  } else throw new Error('Usage: node scripts/github-release.mjs plan|resolve|sync-version|publish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
