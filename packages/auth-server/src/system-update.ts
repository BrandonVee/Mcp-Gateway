import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { hostname } from 'node:os';

/**
 * Self-update through the Docker Engine socket.
 *
 * The application container cannot replace itself: a second container would
 * collide with the published port, and stopping itself first kills the process
 * that still has to create the replacement. Every update therefore runs inside a
 * one-shot updater container (scripts/update-container.mjs) that owns the whole
 * sequence and survives the death of this container.
 */

const API = '/v1.44';
export const DEFAULT_UPDATE_IMAGE = 'brandonvee/mcp-gateway';
export const DEFAULT_UPDATE_TAG = 'latest';
const UPDATER_SCRIPT = '/app/scripts/update-container.mjs';

export function updateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_UPDATE_ENABLED === 'true';
}

export function dockerSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_DOCKER_SOCKET ?? '/var/run/docker.sock';
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface DockerResponse {
  status: number;
  text: string;
  json: unknown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function dockerRequest(
  method: string,
  path: string,
  options: {
    socketPath: string;
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<DockerResponse> {
  const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<DockerResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: options.socketPath,
        path: `${API}${path}${query}`,
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          'content-length': String(Buffer.byteLength(payload ?? '')),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text, json: parseJson(text) }));
      },
    );
    request.on('error', reject);
    request.setTimeout(options.timeoutMs ?? 15_000, () => request.destroy(new Error('docker request timed out')));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** Docker sets HOSTNAME to the short container id; cgroup v2 cannot be parsed for it. */
export function selfId(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOSTNAME ?? hostname();
}

let cachedVersion: string | undefined;
/** The image ships the workspace package.json, so its version is the build version. */
export function readAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = String(
      (JSON.parse(readFileSync('/app/package.json', 'utf8')) as { version?: unknown }).version ?? '',
    );
  } catch {
    cachedVersion = '';
  }
  return cachedVersion;
}

export interface ContainerInspect {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  HostConfig?: Record<string, unknown>;
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[]; IPAddress?: string }> };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

export function buildUpdaterSpec(options: {
  imageId: string;
  oldId: string;
  targetImage: string;
  socketPath: string;
  logPath: string;
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
      Binds: [`${options.socketPath}:${options.socketPath}`, `${options.logPath}:${options.logPath}`],
      // The socket is group-writable on the host; without the host docker group
      // the unprivileged updater cannot talk to the Engine.
      ...(options.groupIds?.length ? { GroupAdd: options.groupIds } : {}),
    },
    Env: [
      ...(options.env ?? []),
      `MCP_DOCKER_SOCKET=${options.socketPath}`,
      `MCP_UPDATE_OLD_ID=${options.oldId}`,
      `MCP_UPDATE_IMAGE=${options.targetImage}`,
      `MCP_UPDATE_LOG=${options.logPath}`,
    ],
    Labels: { 'com.mcp.role': 'updater' },
  };
}

/** Pull streams newline-delimited JSON; a single chunk may hold partial lines. */
export function parsePullProgress(chunks: string[]): { statuses: string[]; error?: string } {
  const statuses: string[] = [];
  let error: string | undefined;
  for (const line of chunks.join('').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { status?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { status?: unknown; error?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.error === 'string' && !error) error = parsed.error;
    if (typeof parsed.status === 'string') statuses.push(parsed.status);
  }
  return { statuses, ...(error ? { error } : {}) };
}

/** The image to pull: an explicit override, otherwise the running image's :latest. */
export function updateTargetImage(inspect: ContainerInspect, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MCP_UPDATE_IMAGE?.trim();
  if (configured) return configured;
  const current = inspect.Config?.Image ?? '';
  const [repo] = current.includes(':') ? current.split(/:(?=[^/]*$)/) : [current];
  if (!repo) return `${DEFAULT_UPDATE_IMAGE}:${DEFAULT_UPDATE_TAG}`;
  return `${repo}:${DEFAULT_UPDATE_TAG}`;
}

export interface UpdateStatus {
  enabled: boolean;
  socket_available: boolean;
  version: string;
  image: string;
  image_id: string;
  container_id: string;
  container_name: string;
}

export async function getUpdateStatus(env: NodeJS.ProcessEnv = process.env): Promise<UpdateStatus> {
  const socketPath = dockerSocket(env);
  const status: UpdateStatus = {
    enabled: updateEnabled(env),
    socket_available: existsSync(socketPath),
    version: readAppVersion(),
    image: '',
    image_id: '',
    container_id: '',
    container_name: '',
  };
  if (!status.enabled || !status.socket_available) return status;
  try {
    const response = await dockerRequest('GET', `/containers/${selfId(env)}/json`, { socketPath, timeoutMs: 2_000 });
    if (response.status < 200 || response.status >= 300) return status;
    const inspect = response.json as ContainerInspect;
    status.container_id = String(inspect.Id ?? '');
    status.container_name = String(inspect.Name ?? '').replace(/^\//, '');
    status.image = String(inspect.Config?.Image ?? '');
    status.image_id = String((response.json as { Image?: unknown }).Image ?? '');
  } catch {
    return status;
  }
  return status;
}

export interface StartedUpdate {
  status: 'started';
  container_id: string;
  container_name: string;
  image: string;
  updater_id: string;
}

/** Create the updater container and return immediately: the pull happens inside it. */
export async function startUpdate(env: NodeJS.ProcessEnv = process.env): Promise<StartedUpdate> {
  if (!updateEnabled(env)) throw new DockerError('system_update_disabled', 503);
  const socketPath = dockerSocket(env);
  if (!existsSync(socketPath)) throw new DockerError('docker_unavailable', 503);
  const id = selfId(env);
  const inspectResponse = await dockerRequest('GET', `/containers/${id}/json`, { socketPath, timeoutMs: 5_000 });
  if (inspectResponse.status < 200 || inspectResponse.status >= 300) throw new DockerError('docker_unavailable', 503);
  const inspect = inspectResponse.json as ContainerInspect;
  const oldImageId = String((inspectResponse.json as { Image?: unknown }).Image ?? '');
  if (!oldImageId) throw new DockerError('docker_unavailable', 503);
  const logPath = env.MCP_UPDATE_LOG ?? '/app/update.log';
  const updater = await dockerRequest('POST', '/containers/create', {
    socketPath,
    query: { name: `mcp-updater-${Date.now()}` },
    body: buildUpdaterSpec({
      imageId: oldImageId,
      oldId: String(inspect.Id ?? id),
      targetImage: updateTargetImage(inspect, env),
      socketPath,
      logPath,
      env: inspect.Config?.Env ?? [],
      groupIds: env.DOCKER_GID ? [env.DOCKER_GID] : [],
    }),
  });
  if (updater.status < 200 || updater.status >= 300) throw new DockerError('system_update_failed', 503);
  const created = asRecord(updater.json);
  const updaterId = String(created.Id ?? '');
  if (!updaterId) throw new DockerError('system_update_failed', 503);
  const started = await dockerRequest('POST', `/containers/${updaterId}/start`, { socketPath });
  if (started.status < 200 || started.status >= 300) {
    await dockerRequest('DELETE', `/containers/${updaterId}`, { socketPath, query: { force: 'true' } }).catch(
      () => undefined,
    );
    throw new DockerError('system_update_failed', 503);
  }
  return {
    status: 'started',
    container_id: String(inspect.Id ?? id),
    container_name: String(inspect.Name ?? '').replace(/^\//, ''),
    image: updateTargetImage(inspect, env),
    updater_id: updaterId,
  };
}
