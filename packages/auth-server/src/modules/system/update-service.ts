import { existsSync } from 'node:fs';
import { DockerError, dockerRequest, dockerSocket } from '../../infrastructure/docker/client.js';
import { asRecord } from '../../shared/serialization/record.js';
import {
  compareVersions,
  getUpdateReleases,
  stableVersion,
  type ReleaseCheckFailure,
  type UpdateRelease,
} from './releases.js';
import {
  imageRepository,
  officialUpdateImage,
  readAppVersion,
  runningVersion,
  selfId,
  updateEnabled,
  updateTargetImage,
  type ImageInspect,
} from './update-identity.js';
import { buildUpdaterSpec, mountedSource, updaterGroups, type ContainerInspect } from './update-spec.js';

export interface UpdateStatus {
  enabled: boolean;
  socket_available: boolean;
  version: string;
  container_ready: boolean;
  latest_version: string;
  update_available: boolean | null;
  releases: UpdateRelease[];
  release_check_error: boolean;
  release_check_failures: ReleaseCheckFailure[];
  releases_supported: boolean;
  checked_at: number | null;
  target_image: string;
  image: string;
  image_id: string;
  container_id: string;
  container_name: string;
}

export async function getUpdateStatus(
  env: NodeJS.ProcessEnv = process.env,
  refresh = false,
  runtimeOnly = false,
): Promise<UpdateStatus> {
  const socketPath = dockerSocket(env);
  const status: UpdateStatus = {
    enabled: updateEnabled(env),
    socket_available: existsSync(socketPath),
    version: readAppVersion(),
    container_ready: false,
    latest_version: '',
    update_available: null,
    releases: [],
    release_check_error: false,
    release_check_failures: [],
    releases_supported: false,
    checked_at: null,
    target_image: '',
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
    const state = (response.json as { State?: { Running?: boolean; Health?: { Status?: string } } }).State;
    status.container_ready = !!state?.Running && (!state.Health || state.Health.Status === 'healthy');
    status.container_id = String(inspect.Id ?? '');
    status.container_name = String(inspect.Name ?? '').replace(/^\//, '');
    status.image = inspect.Config?.Labels?.['com.mcp.update.image'] || String(inspect.Config?.Image ?? '');
    status.target_image = updateTargetImage(inspect, env);
    status.image_id = String((response.json as { Image?: unknown }).Image ?? '');
    status.releases_supported = officialUpdateImage(status.target_image);
    const catalog = status.releases_supported && !runtimeOnly ? await getUpdateReleases(refresh) : null;
    status.releases = catalog?.releases ?? [];
    status.release_check_error = catalog?.error ?? false;
    status.release_check_failures = catalog?.failures ?? [];
    status.checked_at = catalog?.checked_at ?? null;
    status.latest_version = status.releases[0]?.version ?? '';
    const imageResponse = await dockerRequest('GET', `/images/${encodeURIComponent(status.image_id)}/json`, {
      socketPath,
      timeoutMs: 2_000,
    });
    if (imageResponse.status === 200)
      status.version = runningVersion(imageResponse.json as ImageInspect, status.releases, status.version);
    if (status.version && status.latest_version && !status.release_check_error)
      status.update_available = compareVersions(status.latest_version, status.version) > 0;
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
export async function startUpdate(env: NodeJS.ProcessEnv = process.env, tag = 'latest'): Promise<StartedUpdate> {
  if (!updateEnabled(env)) throw new DockerError('system_update_disabled', 503);
  const socketPath = dockerSocket(env);
  if (!existsSync(socketPath)) throw new DockerError('docker_unavailable', 503);
  const id = selfId(env);
  const inspectResponse = await dockerRequest('GET', `/containers/${id}/json`, { socketPath, timeoutMs: 5_000 });
  if (inspectResponse.status < 200 || inspectResponse.status >= 300) throw new DockerError('docker_unavailable', 503);
  const inspect = inspectResponse.json as ContainerInspect;
  const oldImageId = String((inspectResponse.json as { Image?: unknown }).Image ?? '');
  if (!oldImageId) throw new DockerError('docker_unavailable', 503);
  let targetImage = updateTargetImage(inspect, env);
  if (tag !== 'latest') {
    if (!stableVersion(tag) || !officialUpdateImage(targetImage)) throw new DockerError('invalid_update_version', 400);
    const catalog = await getUpdateReleases();
    const release = catalog.releases.find((item) => item.tag === tag);
    if (!release) throw new DockerError('invalid_update_version', 400);
    targetImage = `${imageRepository(targetImage)}@${release.digest}`;
  }
  const logPath = env.MCP_UPDATE_LOG ?? '/app/update.log';
  const socketSource = mountedSource(inspect, socketPath);
  if (!socketSource) throw new DockerError('system_update_socket_not_mounted', 503);
  const updater = await dockerRequest('POST', '/containers/create', {
    socketPath,
    query: { name: `mcp-updater-${String(inspect.Id ?? id)}` },
    body: buildUpdaterSpec({
      imageId: oldImageId,
      oldId: String(inspect.Id ?? id),
      targetImage,
      socketPath,
      logPath,
      socketSource,
      logSource: mountedSource(inspect, logPath),
      env: inspect.Config?.Env ?? [],
      groupIds: updaterGroups(inspect, socketPath, env),
    }),
  });
  if (updater.status === 409) throw new DockerError('system_update_in_progress', 409);
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
    image: targetImage,
    updater_id: updaterId,
  };
}

export interface UpdateTaskStatus {
  status: 'running' | 'succeeded' | 'failed' | 'missing' | 'unknown';
}

/** Read only managed updater containers; never expose their environment or logs. */
export async function getUpdateTaskStatus(id: string, env: NodeJS.ProcessEnv = process.env): Promise<UpdateTaskStatus> {
  if (!/^[a-f\d]{64}$/.test(id)) throw new DockerError('invalid_update_task', 400);
  try {
    const response = await dockerRequest('GET', `/containers/${id}/json`, {
      socketPath: dockerSocket(env),
      timeoutMs: 2_000,
    });
    if (response.status === 404) return { status: 'missing' };
    if (response.status !== 200) return { status: 'unknown' };
    const inspect = response.json as ContainerInspect & {
      State?: { Status?: string; Running?: boolean; ExitCode?: number };
    };
    if (inspect.Config?.Labels?.['com.mcp.role'] !== 'updater') throw new DockerError('invalid_update_task', 400);
    if (inspect.State?.Running || ['created', 'restarting'].includes(inspect.State?.Status ?? ''))
      return { status: 'running' };
    if (inspect.State?.Status === 'exited') return { status: inspect.State.ExitCode === 0 ? 'succeeded' : 'failed' };
    return { status: 'unknown' };
  } catch (error) {
    if (error instanceof DockerError) throw error;
    return { status: 'unknown' };
  }
}
