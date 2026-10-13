import { request as httpRequest } from 'node:http';

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
