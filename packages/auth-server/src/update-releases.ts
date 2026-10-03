/** Only published stable releases with an image digest can be installed. */
export interface UpdateRelease {
  tag: string;
  version: string;
  digest: string;
  revision?: string;
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
      const response = await fetch('https://api.github.com/repos/BrandonVee/Mcp-Gateway/releases?per_page=100', {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Mcp-Gateway-Updater',
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('release check failed');
      cache = { releases: parseReleases(await response.json()), checkedAt: Date.now() };
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
