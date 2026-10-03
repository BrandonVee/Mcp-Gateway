import { EnvHttpProxyAgent, type Dispatcher } from 'undici';

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

export type ReleaseFailureReason =
  'timeout' | 'dns' | 'tls' | 'network' | 'rate_limited' | 'http' | 'invalid_response' | 'proxy_configuration';
export interface ReleaseCheckFailure {
  source: 'github' | 'dockerhub';
  reason: ReleaseFailureReason;
  http_status?: number;
}

/** Return only safe categories, never exception text that may contain proxy credentials. */
export function releaseFailureReason(error: unknown): ReleaseFailureReason {
  const codes: string[] = [];
  const names: string[] = [];
  const seen = new Set<unknown>();
  const inspect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return;
    seen.add(value);
    const record = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string') codes.push(record.code);
    if (typeof record.name === 'string') names.push(record.name);
    inspect(record.cause, depth + 1);
    if (Array.isArray(record.errors)) record.errors.slice(0, 20).forEach((item) => inspect(item, depth + 1));
  };
  inspect(error);
  if (codes.some((code) => /CERT|TLS|SSL/.test(code)) || codes.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))
    return 'tls';
  if (codes.some((code) => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code))) return 'dns';
  if (names.includes('TimeoutError') || codes.some((code) => /TIMEOUT|ETIMEDOUT/.test(code))) return 'timeout';
  return 'network';
}

class SourceLookupError extends Error {
  constructor(readonly failure: ReleaseCheckFailure) {
    super('release_source_lookup_failed');
  }
}
export class ReleaseLookupError extends Error {
  constructor(readonly failures: ReleaseCheckFailure[]) {
    super('release_lookup_failed');
  }
}

/** Scope proxy and address-family handling to version checks, preserving other HTTP clients. */
export function createReleaseDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher {
  const connect = { timeout: 15_000, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 };
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? '';
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy;
  for (const proxy of [httpProxy, httpsProxy]) {
    if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error('invalid_release_proxy');
  }
  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
    connect,
    proxyTls: connect,
    requestTls: connect,
  });
}
let dispatcher: Dispatcher | undefined;

export async function fetchPublishedReleases(fetchImpl: typeof fetch = fetch): Promise<UpdateRelease[]> {
  const sources = [
    {
      source: 'github' as const,
      url: 'https://api.github.com/repos/BrandonVee/Mcp-Gateway/releases?per_page=100',
      parse: parseReleases,
    },
    {
      source: 'dockerhub' as const,
      url: 'https://hub.docker.com/v2/namespaces/brandonvee/repositories/mcp-gateway/tags?page_size=100&name=v',
      parse: parseImageTags,
    },
  ];
  const controllers = sources.map(() => new AbortController());
  const tasks = sources.map(async ({ source, url, parse }, index) => {
    let transport: Dispatcher;
    try {
      transport = dispatcher ??= createReleaseDispatcher();
    } catch {
      throw new SourceLookupError({ source, reason: 'proxy_configuration' });
    }
    try {
      const options: RequestInit & { dispatcher: Dispatcher } = {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mcp-Gateway-Updater',
          ...(source === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        },
        signal: AbortSignal.any([AbortSignal.timeout(15_000), controllers[index].signal]),
        dispatcher: transport,
      };
      const response = await fetchImpl(url, options);
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceLookupError({
          source,
          reason:
            response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' ? 'rate_limited' : 'http',
          http_status: response.status,
        });
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) throw new SourceLookupError({ source, reason: 'invalid_response' });
        throw error;
      }
      try {
        const releases = parse(data);
        if (!releases.length) throw new Error('no published images');
        return releases;
      } catch {
        throw new SourceLookupError({ source, reason: 'invalid_response' });
      }
    } catch (error) {
      if (error instanceof SourceLookupError) throw error;
      throw new SourceLookupError({ source, reason: releaseFailureReason(error) });
    }
  });
  try {
    return await Promise.any(tasks);
  } catch (error) {
    const failures =
      error instanceof AggregateError
        ? error.errors
            .filter((item): item is SourceLookupError => item instanceof SourceLookupError)
            .map((item) => item.failure)
        : [];
    throw new ReleaseLookupError(failures);
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
}

export interface ReleaseCatalogResult {
  releases: UpdateRelease[];
  checked_at: number | null;
  error: boolean;
  failures: ReleaseCheckFailure[];
}

/** Successful metadata is retained, but a failed recheck never becomes a fresh success. */
export function createReleaseCatalog(load: () => Promise<UpdateRelease[]> = fetchPublishedReleases, now = Date.now) {
  let cache: { releases: UpdateRelease[]; checkedAt: number } | undefined;
  let retryAfter = 0;
  let failed = false;
  let failures: ReleaseCheckFailure[] = [];
  let pending: Promise<ReleaseCatalogResult> | undefined;
  const result = (error: boolean): ReleaseCatalogResult => ({
    releases: cache?.releases ?? [],
    checked_at: cache?.checkedAt ?? null,
    error,
    failures: error ? failures : [],
  });
  return async (refresh = false): Promise<ReleaseCatalogResult> => {
    if (pending) return pending;
    if (!refresh && now() < retryAfter) return result(true);
    if (cache && !refresh && !failed && now() - cache.checkedAt < 300_000) return result(false);
    pending = (async () => {
      try {
        cache = { releases: await load(), checkedAt: now() };
        retryAfter = 0;
        failed = false;
        failures = [];
        return result(false);
      } catch (error) {
        failed = true;
        failures = error instanceof ReleaseLookupError ? error.failures : [];
        retryAfter = now() + 30_000;
        return result(true);
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

export const getUpdateReleases = createReleaseCatalog();
