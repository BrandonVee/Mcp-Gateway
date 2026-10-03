// One-shot updater: replaces the application container with a freshly pulled
// image. It runs in its own container (created by the app through the Docker
// socket) because the application cannot replace itself: the published port is
// still bound while it is alive, and stopping itself first would kill the only
// process able to create the replacement.
//
// Dependency-free: it is executed straight from the image with plain node.
import { appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const API = '/v1.44';
const socketPath = process.env.MCP_DOCKER_SOCKET ?? '/var/run/docker.sock';
const oldId = process.env.MCP_UPDATE_OLD_ID ?? '';
const targetImage = process.env.MCP_UPDATE_IMAGE ?? '';
const logPath = process.env.MCP_UPDATE_LOG ?? '';
const healthTimeoutMs = 90_000;

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (logPath) {
    try {
      appendFileSync(logPath, line);
    } catch {
      /* A missing log file must never abort an update. */
    }
  }
  process.stdout.write(line);
}

function request(method, path, { query, body, timeoutMs = 30_000, stream = false } = {}) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      {
        socketPath,
        path: `${API}${path}${search}`,
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          'content-length': String(Buffer.byteLength(payload ?? '')),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    client.on('error', reject);
    // Pulls legitimately take minutes; the read timeout only guards a hung daemon.
    client.setTimeout(stream ? 600_000 : timeoutMs, () => client.destroy(new Error(`${method} ${path} timed out`)));
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

const json = (response) => {
  try {
    return JSON.parse(response.text);
  } catch {
    return undefined;
  }
};
const ok = (response) => response.status >= 200 && response.status < 300;

async function pull() {
  // A digest reference cannot be split on ':', and a registry host may carry a port.
  const at = targetImage.indexOf('@');
  const colon = targetImage.lastIndexOf(':');
  const digest = at >= 0;
  const tagged = !digest && colon > targetImage.lastIndexOf('/');
  const repo = tagged ? targetImage.slice(0, colon) : targetImage;
  const tag = tagged ? targetImage.slice(colon + 1) : 'latest';
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`pulling ${repo}:${tag} (attempt ${attempt})`);
    const response = await request('POST', '/images/create', {
      query: { fromImage: repo, ...(tag ? { tag } : {}) },
      stream: true,
    });
    for (const line of response.text.split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.error) throw new Error(String(parsed.error));
    }
    if (!ok(response)) {
      if (attempt === 2) throw new Error(`pull failed: HTTP ${response.status} ${response.text.slice(0, 200)}`);
      continue;
    }
    const inspected = await request('GET', `/images/${encodeURIComponent(targetImage)}/json`);
    const id = json(inspected)?.Id;
    if (ok(inspected) && typeof id === 'string' && id) return id;
    if (attempt === 2) throw new Error('pulled image has no id');
  }
  throw new Error('pull failed');
}

/** Mirrors buildCreateSpec() in packages/auth-server/src/system-update.ts. */
function createSpec(inspect, imageId) {
  const hostConfig = { ...(inspect.HostConfig ?? {}) };
  delete hostConfig.NetworkMode;
  const endpointsConfig = {};
  for (const [name, network] of Object.entries(inspect.NetworkSettings?.Networks ?? {})) {
    endpointsConfig[name] = network?.Aliases?.length ? { Aliases: network.Aliases } : {};
  }
  return {
    Image: imageId,
    Env: inspect.Config?.Env ?? [],
    Labels: inspect.Config?.Labels ?? {},
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: endpointsConfig },
  };
}

function hostPort(inspect) {
  const bindings = inspect.HostConfig?.PortBindings ?? {};
  for (const ports of Object.values(bindings)) {
    const hostPort = ports?.[0]?.HostPort;
    if (hostPort) return String(hostPort);
  }
  return '8080';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(port) {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {
      /* Still starting. */
    }
    await sleep(2_000);
  }
  return false;
}

async function main() {
  if (!oldId || !targetImage) throw new Error('MCP_UPDATE_OLD_ID and MCP_UPDATE_IMAGE are required');
  const imageId = await pull();
  log(`pulled ${targetImage} as ${imageId}`);
  const inspected = await request('GET', `/containers/${oldId}/json`);
  if (!ok(inspected)) throw new Error(`cannot inspect ${oldId}: HTTP ${inspected.status}`);
  const inspect = json(inspected);
  const name = String(inspect.Name ?? '').replace(/^\//, '');
  const rollbackName = `${name}-rollback`;

  // Free the service name and the published port before creating the
  // replacement, but keep the old container around until the new one answers.
  await request('DELETE', `/containers/${rollbackName}`, { query: { force: 'true' } }).catch(() => undefined);
  const renamed = await request('POST', `/containers/${oldId}/rename`, { query: { name: rollbackName } });
  if (!ok(renamed)) throw new Error(`cannot rename ${name}: ${renamed.text.slice(0, 200)}`);
  await request('POST', `/containers/${oldId}/stop`, { query: { t: '15' } }).catch(() => undefined);
  log('stopped the previous container');

  const created = await request('POST', '/containers/create', {
    query: { name },
    body: createSpec(inspect, imageId),
  });
  const newId = json(created)?.Id;
  if (!ok(created) || !newId) throw new Error(`cannot create ${name}: ${created.text.slice(0, 200)}`);
  const started = await request('POST', `/containers/${newId}/start`);
  if (!ok(started)) throw new Error(`cannot start ${name}: ${started.text.slice(0, 200)}`);
  log(`started ${newId}`);

  if (await waitForHealth(hostPort(inspect))) {
    await request('DELETE', `/containers/${oldId}`, { query: { force: 'true' } }).catch(() => undefined);
    log(`update complete: ${name} now runs ${imageId}`);
    return;
  }

  // Roll back: drop the replacement and bring the previous container back.
  log('new container never became healthy; rolling back');
  await request('DELETE', `/containers/${newId}`, { query: { force: 'true' } }).catch(() => undefined);
  await request('POST', `/containers/${oldId}/rename`, { query: { name } }).catch(() => undefined);
  const restarted = await request('POST', `/containers/${oldId}/start`).catch(() => undefined);
  log(
    restarted && ok(restarted) ? 'rolled back to the previous container' : 'rollback failed: run deploy.sh on the host',
  );
  process.exitCode = 1;
}

main().catch((error) => {
  log(`update failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
