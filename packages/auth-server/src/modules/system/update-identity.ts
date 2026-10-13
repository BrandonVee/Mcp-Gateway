import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { stableVersion, type UpdateRelease } from './releases.js';
import type { ContainerInspect } from './update-spec.js';

export const DEFAULT_UPDATE_IMAGE = 'brandonvee/mcp-gateway';

export const DEFAULT_UPDATE_TAG = 'latest';

export function updateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_UPDATE_ENABLED === 'true';
}

/** Docker sets HOSTNAME to the short container id; cgroup v2 cannot be parsed for it. */
export function selfId(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOSTNAME ?? hostname();
}

let cachedVersion: string | undefined;

/** Release builds embed their resolved version, independently of workspace manifests. */
export function readAppVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = stableVersion(
      (JSON.parse(readFileSync('/app/build-info.json', 'utf8')) as { version?: unknown }).version,
    );
  } catch {
    cachedVersion = '';
  }
  return cachedVersion;
}

export interface ImageInspect {
  Config?: { Labels?: Record<string, string> };
  RepoDigests?: string[];
  RepoTags?: string[];
}

export function runningVersion(image: ImageInspect, releases: UpdateRelease[], embedded = ''): string {
  const digests = image.RepoDigests?.map((value) => value.split('@')[1]) ?? [];
  const revision = image.Config?.Labels?.['org.opencontainers.image.revision'];
  const release = releases.find(
    (item) =>
      digests.includes(item.digest) ||
      item.platform_digests?.some((digest) => digests.includes(digest)) ||
      (item.revision && item.revision === revision),
  );
  return (
    release?.version ||
    stableVersion(embedded) ||
    stableVersion(image.Config?.Labels?.['org.opencontainers.image.version'])
  );
}

/** The image to pull: an explicit override, otherwise the running image's :latest. */
export function updateTargetImage(inspect: ContainerInspect, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MCP_UPDATE_IMAGE?.trim();
  if (configured) return configured;
  const current = inspect.Config?.Labels?.['com.mcp.update.image'] || inspect.Config?.Image || '';
  const repo = imageRepository(current);
  if (!repo) return `${DEFAULT_UPDATE_IMAGE}:${DEFAULT_UPDATE_TAG}`;
  return `${repo}:${DEFAULT_UPDATE_TAG}`;
}

export function imageRepository(image: string): string {
  if (/^sha256:/.test(image)) return '';
  return image.split('@')[0].replace(/:[^/]*$/, '');
}

export function officialUpdateImage(image: string): boolean {
  return [
    DEFAULT_UPDATE_IMAGE,
    `docker.io/${DEFAULT_UPDATE_IMAGE}`,
    `index.docker.io/${DEFAULT_UPDATE_IMAGE}`,
  ].includes(imageRepository(image));
}
