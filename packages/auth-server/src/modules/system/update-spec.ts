import { statSync } from 'node:fs';
import { posix } from 'node:path';
import { asRecord } from '@/auth/shared/serialization/record.js';

const UPDATER_SCRIPT = '/app/scripts/update-container.mjs';

export interface ContainerInspect {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  HostConfig?: Record<string, unknown>;
  Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>;
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[]; IPAddress?: string }> };
}

/**
 * Reuse the running container's environment, labels, host config and networks,
 * but not Entrypoint/Cmd/Healthcheck: those are resolved from the *old* image
 * and would pin the replacement to the previous image's defaults.
 */
export function buildCreateSpec(inspect: ContainerInspect, imageId: string): Record<string, unknown> {
  const hostConfig = { ...asRecord(inspect.HostConfig) };
  // NetworkingConfig and NetworkMode conflict; Compose only sends EndpointsConfig.
  delete hostConfig.NetworkMode;
  const networks = (inspect.NetworkSettings?.Networks ?? {}) as Record<string, { Aliases?: string[] } | undefined>;
  const endpointsConfig: Record<string, { Aliases?: string[] }> = {};
  for (const [name, network] of Object.entries(networks)) {
    const aliases = Array.isArray(network?.Aliases) ? network.Aliases : undefined;
    endpointsConfig[name] = aliases?.length ? { Aliases: aliases } : {};
  }
  return {
    Image: imageId,
    Env: inspect.Config?.Env ?? [],
    Labels: inspect.Config?.Labels ?? {},
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: endpointsConfig },
  };
}

/** Engine bind sources belong to the host, not this container's filesystem. */
export function mountedSource(inspect: ContainerInspect, path: string): string | undefined {
  const normalized = posix.normalize(path);
  const mount = inspect.Mounts?.filter(
    (item) =>
      item.Source &&
      item.Destination &&
      (normalized === item.Destination || normalized.startsWith(`${item.Destination.replace(/\/$/, '')}/`)),
  ).sort((a, b) => b.Destination!.length - a.Destination!.length)[0];
  if (!mount?.Source || !mount.Destination) return undefined;
  return posix.join(mount.Source, posix.relative(mount.Destination, normalized));
}

export function updaterGroups(inspect: ContainerInspect, socketPath: string, env: NodeJS.ProcessEnv): string[] {
  const groups = Array.isArray(inspect.HostConfig?.GroupAdd) ? inspect.HostConfig.GroupAdd.map(String) : [];
  if (env.DOCKER_GID) groups.push(env.DOCKER_GID);
  try {
    groups.push(String(statSync(socketPath).gid));
  } catch {
    /* Existing groups remain usable. */
  }
  return [...new Set(groups)];
}

export function buildUpdaterSpec(options: {
  imageId: string;
  oldId: string;
  targetImage: string;
  socketPath: string;
  socketSource: string;
  logPath: string;
  logSource?: string;
  env?: string[];
  groupIds?: string[];
}): Record<string, unknown> {
  return {
    Image: options.imageId,
    Entrypoint: ['/sbin/tini', '--', 'node'],
    Cmd: [UPDATER_SCRIPT],
    // Host networking is the only way the updater can reach the port this
    // deployment publishes on loopback to check whether the new container is up.
    HostConfig: {
      NetworkMode: 'host',
      AutoRemove: true,
      Mounts: [
        { Type: 'bind', Source: options.socketSource, Target: options.socketPath },
        ...(options.logSource ? [{ Type: 'bind', Source: options.logSource, Target: options.logPath }] : []),
      ],
      // The socket is group-writable on the host; without the host docker group
      // the unprivileged updater cannot talk to the Engine.
      ...(options.groupIds?.length ? { GroupAdd: options.groupIds } : {}),
    },
    Env: [
      ...(options.env ?? []).filter(
        (entry) => !/^(MCP_DOCKER_SOCKET|MCP_UPDATE_OLD_ID|MCP_UPDATE_IMAGE|MCP_UPDATE_LOG)=/.test(entry),
      ),
      `MCP_DOCKER_SOCKET=${options.socketPath}`,
      `MCP_UPDATE_OLD_ID=${options.oldId}`,
      `MCP_UPDATE_IMAGE=${options.targetImage}`,
      `MCP_UPDATE_LOG=${options.logSource ? options.logPath : ''}`,
    ],
    Labels: { 'com.mcp.role': 'updater' },
  };
}
