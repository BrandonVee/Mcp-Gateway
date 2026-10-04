import { isIP } from 'node:net';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import pLimit from 'p-limit';

interface InstanceHealth {
  transportUnavailableUntil: number;
  httpUnavailableUntil: number;
}

/** Transport availability is deliberately separate from MCP/tool HTTP errors. */
export class UpstreamHealthTracker {
  private readonly instances = new Map<string, InstanceHealth>();

  constructor(private readonly cooldownMs = 15_000) {}

  isAvailable(url: string, now = Date.now()): boolean {
    const state = this.instances.get(url);
    return !state || (state.transportUnavailableUntil <= now && state.httpUnavailableUntil <= now);
  }

  recordSuccess(url: string, source: 'request' | 'probe' = 'request'): void {
    if (source === 'request') {
      this.instances.delete(url);
      return;
    }
    const state = this.instances.get(url);
    if (state) this.instances.set(url, { ...state, transportUnavailableUntil: 0 });
  }

  recordFailure(url: string, source: 'transport' | 'http' = 'transport', now = Date.now()): void {
    const state = this.instances.get(url) ?? { transportUnavailableUntil: 0, httpUnavailableUntil: 0 };
    this.instances.set(
      url,
      source === 'transport'
        ? { ...state, transportUnavailableUntil: now + this.cooldownMs }
        : { ...state, httpUnavailableUntil: now + this.cooldownMs },
    );
  }

  forgetRemoved(activeUrls: Iterable<string>): void {
    const active = new Set(activeUrls);
    for (const url of this.instances.keys()) if (!active.has(url)) this.instances.delete(url);
  }

  unavailableCount(urls: Iterable<string>, now = Date.now()): number {
    return [...new Set(urls)].filter((url) => !this.isAvailable(url, now)).length;
  }

  /** Read-only copy of cooldown state, for publishing to Redis (topology view). */
  snapshot(): Record<string, { transport_until: number; http_until: number }> {
    const state: Record<string, { transport_until: number; http_until: number }> = {};
    for (const [url, entry] of this.instances)
      state[url] = {
        transport_until: entry.transportUnavailableUntil,
        http_until: entry.httpUnavailableUntil,
      };
    return state;
  }
}

export const upstreamHealth = new UpstreamHealthTracker();

/** TCP/TLS handshake checks reachability without assuming a nonstandard /health route. */
export async function probeUpstreamTransport(endpoint: string, timeoutMs = 2_000): Promise<boolean> {
  const url = new URL(endpoint);
  const tls = url.protocol === 'https:';
  const port = Number(url.port || (tls ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<boolean>((resolve) => {
    const socket = tls
      ? connectTls({ host, port, ...(isIP(host) ? {} : { servername: host }) })
      : connectTcp({ host, port });
    let finished = false;
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(available: boolean): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(available);
    }
    socket.once(tls ? 'secureConnect' : 'connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

/** Probe a bounded number of registered endpoints at a time. */
export async function probeRegisteredUpstreams(urls: Iterable<string>): Promise<void> {
  const unique = [...new Set(urls)];
  upstreamHealth.forgetRemoved(unique);
  const limit = pLimit(10);
  await Promise.all(
    unique.map((url) =>
      limit(async () => {
        if (await probeUpstreamTransport(url)) upstreamHealth.recordSuccess(url, 'probe');
        else upstreamHealth.recordFailure(url, 'transport');
      }),
    ),
  );
}

export function orderedAvailableInstances(
  instances: readonly string[],
  preferredIndex: number,
  health: UpstreamHealthTracker = upstreamHealth,
): string[] {
  if (!instances.length) return [];
  return instances
    .map((_, offset) => instances[(preferredIndex + offset) % instances.length])
    .filter((url) => health.isAvailable(url));
}

/** Only initialize can be replayed on another instance before a session exists. */
export function isRetryableInitialize(method: string, sessionId: string | undefined, body: unknown): boolean {
  if (method !== 'POST' || sessionId || !Buffer.isBuffer(body)) return false;
  try {
    const message = JSON.parse(body.toString('utf8')) as { method?: unknown };
    return message !== null && !Array.isArray(message) && message.method === 'initialize';
  } catch {
    return false;
  }
}
