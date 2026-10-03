/** Only published stable images with an immutable digest can be installed. */
export interface UpdateRelease {
  tag: string;
  version: string;
  digest: string;
  revision?: string;
  platform_digests?: string[];
}

export function stableVersion(value: unknown): string {
  if (typeof value !== 'string') return '';
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value.replace(/^v/, '') : '';
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function parseReleases(data: unknown): UpdateRelease[] {
  if (!Array.isArray(data)) throw new Error('invalid release response');
  const releases = new Map<string, UpdateRelease>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const release = item as Record<string, unknown>;
    const version = stableVersion(release.tag_name);
    const digest =
      typeof release.body === 'string' ? /Digest:\s*`(sha256:[a-f\d]{64})`/.exec(release.body)?.[1] : undefined;
    if (release.draft || release.prerelease || !version || !digest || release.tag_name !== `v${version}`) continue;
    releases.set(version, {
      tag: `v${version}`,
      version,
      digest,
      ...(typeof release.target_commitish === 'string' && /^[a-f\d]{40}$/.test(release.target_commitish)
        ? { revision: release.target_commitish }
        : {}),
    });
  }
  return [...releases.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** Docker Hub remains usable when GitHub's anonymous API quota is exhausted. */
export function parseImageTags(data: unknown): UpdateRelease[] {
  const results = data && typeof data === 'object' ? (data as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) throw new Error('invalid image tag response');
  const releases = new Map<string, UpdateRelease>();
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const tag = item as Record<string, unknown>;
    const version = stableVersion(tag.name);
    if (
      !version ||
      tag.name !== `v${version}` ||
      tag.tag_status !== 'active' ||
      typeof tag.digest !== 'string' ||
      !/^sha256:[a-f\d]{64}$/.test(tag.digest)
    )
      continue;
    const platformDigests = Array.isArray(tag.images)
      ? tag.images.flatMap((image: Record<string, unknown>) =>
          image &&
          image.status === 'active' &&
          typeof image.digest === 'string' &&
          /^sha256:[a-f\d]{64}$/.test(image.digest)
            ? [image.digest]
            : [],
        )
      : [];
    releases.set(version, { tag: `v${version}`, version, digest: tag.digest, platform_digests: platformDigests });
  }
  return [...releases.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export async function fetchPublishedReleases(fetchImpl: typeof fetch = fetch): Promise<UpdateRelease[]> {
  try {
    const response = await fetchImpl('https://api.github.com/repos/BrandonVee/Mcp-Gateway/releases?per_page=100', {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Mcp-Gateway-Updater',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('release check failed');
    const releases = parseReleases(await response.json());
    if (!releases.length) throw new Error('no published releases');
    return releases;
  } catch {
    const response = await fetchImpl(
      'https://hub.docker.com/v2/namespaces/brandonvee/repositories/mcp-gateway/tags?page_size=100&name=v',
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error('image version check failed');
    const releases = parseImageTags(await response.json());
    if (!releases.length) throw new Error('no published images');
    return releases;
  }
}

let cache: { releases: UpdateRelease[]; checkedAt: number } | undefined;
let retryAfter = 0;
let pending: Promise<{ releases: UpdateRelease[]; checked_at: number | null; error: boolean }> | undefined;
export async function getUpdateReleases(refresh = false) {
  if (pending) return pending;
  if (Date.now() < retryAfter)
    return { releases: cache?.releases ?? [], checked_at: cache?.checkedAt ?? null, error: true };
  if (cache && !refresh && Date.now() - cache.checkedAt < 300_000)
    return { releases: cache.releases, checked_at: cache.checkedAt, error: false };
  pending = (async () => {
    try {
      cache = { releases: await fetchPublishedReleases(), checkedAt: Date.now() };
      return { releases: cache.releases, checked_at: cache.checkedAt, error: false };
    } catch {
      retryAfter = Date.now() + 30_000;
      return { releases: cache?.releases ?? [], checked_at: cache?.checkedAt ?? null, error: true };
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}
