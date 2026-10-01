import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
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

export async function publishRelease({ repository, token, tag, sha, digest, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !versionPattern.test(tag) || !/^[a-f\d]{40}$/.test(sha)) throw new Error('Invalid release repository, tag, or commit');
  if (!token || !/^sha256:[a-f\d]{64}$/.test(digest)) throw new Error('Release requires a GitHub token and a published image digest');
  const api = async (path, method = 'GET', body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const ref = await api(`git/ref/tags/${tag}`);
  if (ref) {
    let object = ref.object;
    for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = (await api(`git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== sha) throw new Error(`Existing ${tag} points at another commit; refusing to move it`);
  } else {
    const annotated = await api('git/tags', 'POST', {
      tag, message: `Release ${tag}`, object: sha, type: 'commit',
      tagger: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', date: new Date().toISOString() },
    });
    await api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: annotated.sha });
  }
  const existing = await api(`releases/tags/${tag}`);
  if (existing && !existing.draft) return existing;
  const notes = await api('releases/generate-notes', 'POST', { tag_name: tag, target_commitish: sha });
  const body = `${notes.body}\n\n### Docker image\n\n` +
    `\`brandonvee/mcp-gateway:${tag}\` (linux/amd64, linux/arm64)\n\n` +
    `Digest: \`${digest}\`\n\n` +
    `\`MCP_IMAGE_PREFIX=brandonvee/ MCP_IMAGE_NAME=mcp-gateway MCP_VERSION=${tag} ./scripts/deploy.sh --yes\`\n`;
  const payload = { tag_name: tag, target_commitish: sha, name: tag, body, draft: false, prerelease: false, make_latest: 'true' };
  return existing ? api(`releases/${existing.id}`, 'PATCH', payload) : api('releases', 'POST', payload);
}

async function main() {
  if (process.argv[2] === 'prepare') {
    const release = prepareRelease();
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(release).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`Selected ${release.tag} for ${release.sha}`);
  } else if (process.argv[2] === 'publish') {
    const release = await publishRelease({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
      tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA, digest: process.env.IMAGE_DIGEST, apiUrl: process.env.GITHUB_API_URL });
    console.log(`Published ${release.html_url}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### GitHub Release\n\n[${release.tag_name}](${release.html_url})\n`);
  } else throw new Error('Usage: node scripts/github-release.mjs prepare|publish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
