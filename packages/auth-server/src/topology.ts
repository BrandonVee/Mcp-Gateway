import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadPlatformConfig, runtimeSettings } from '@mcp/shared';
import { db } from './db.js';
import { mcpServerInstances, mcpServers, users } from './schema.js';

const redis = new Redis(process.env.REDIS_URL ?? loadPlatformConfig().gateway.redisUrl, {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
});
redis.on('error', () => {
  /* Snapshot assembly degrades per section; the API surfaces flags instead. */
});

/** Matches the anonymized instance id in gateway call events. */
export const instanceId = (url: string): string =>
  createHash('sha256').update(url).digest('hex').slice(0, 12);

export type InstanceHealthState = 'up' | 'degraded' | 'down' | 'unknown';

export interface TopologySnapshot {
  generated_at: number;
  window_seconds: number;
  monitoring_enabled: boolean;
  servers: Array<{
    name: string;
    display_name: string;
    enabled: boolean;
    instances: Array<{
      id: string;
      url: string;
      enabled: boolean;
      health: {
        state: InstanceHealthState;
        replicas_total: number;
        replicas_down: number;
        last_probe_age_ms: number | null;
      };
    }>;
  }>;
  sessions: Array<{ server: string; instance: string; owner: string; count: number }>;
  flows: Array<{
    server: string;
    instance: string;
    username: string;
    client_id: string;
    calls: number;
    failed: number;
  }>;
  degraded: { health: boolean; sessions: boolean; flows: boolean };
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/** Cross-replica health: a replica's hash expires 45s after it stops reporting. */
async function collectHealth(now: number): Promise<Map<string, { total: number; down: number; probe: number }>> {
  const perInstance = new Map<string, { total: number; down: number; probe: number }>();
  for (const key of await scanKeys('gw:health:*')) {
    const hash = await redis.hgetall(key);
    for (const [url, raw] of Object.entries(hash)) {
      let entry: { t?: number; h?: number; p?: number };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const state = perInstance.get(url) ?? { total: 0, down: 0, probe: 0 };
      state.total += 1;
      if ((entry.t ?? 0) > now || (entry.h ?? 0) > now) state.down += 1;
      state.probe = Math.max(state.probe, entry.p ?? 0);
      perInstance.set(url, state);
    }
  }
  return perInstance;
}

/** Sticky-session edges aggregated from live Redis bindings. */
async function collectSessions(): Promise<Map<string, { server: string; instance: string; owner: string; count: number }>> {
  const keys = await scanKeys('gw:bind:*');
  const edges = new Map<string, { server: string; instance: string; owner: string; count: number }>();
  if (!keys.length) return edges;
  const pipe = redis.pipeline();
  for (const key of keys) {
    pipe.get(key);
    pipe.get(`gw:owner:${key.slice('gw:bind:'.length)}`);
  }
  const results = await pipe.exec();
  const usernames = new Map<number, string>();
  for (let i = 0; i < keys.length; i++) {
    const server = keys[i].slice('gw:bind:'.length).split(':')[0];
    const url = results?.[i * 2]?.[1];
    const owner = results?.[i * 2 + 1]?.[1];
    if (typeof url !== 'string' || typeof owner !== 'string' || !owner) continue;
    const numericOwner = /^\d+$/.test(owner) ? Number(owner) : null;
    if (numericOwner !== null && !usernames.has(numericOwner)) usernames.set(numericOwner, '');
    const edgeKey = [server, url, owner].join('\x1f');
    const edge = edges.get(edgeKey) ?? { server, instance: instanceId(url), owner, count: 0 };
    edge.count += 1;
    edges.set(edgeKey, edge);
  }
  const ids = [...usernames.keys()];
  if (ids.length) {
    const rows = await db.select({ id: users.id, username: users.username }).from(users);
    for (const row of rows) if (usernames.has(row.id)) usernames.set(row.id, row.username);
  }
  for (const edge of edges.values())
    if (/^\d+$/.test(edge.owner)) edge.owner = usernames.get(Number(edge.owner)) || `#${edge.owner}`;
  return edges;
}

/** Rolling per-minute flow counters written by the monitoring consumer. */
async function collectFlows(
  windowMinutes: number,
  now: number,
): Promise<
  Map<string, { server: string; instance: string; username: string; client_id: string; calls: number; failed: number }>
> {
  const edges = new Map<
    string,
    { server: string; instance: string; username: string; client_id: string; calls: number; failed: number }
  >();
  const currentBucket = Math.floor(now / 60000) * 60000;
  const pipe = redis.pipeline();
  for (let i = 0; i < windowMinutes; i++) {
    pipe.hgetall(`gw:topo:flow:${currentBucket - i * 60000}`);
    pipe.hgetall(`gw:topo:fail:${currentBucket - i * 60000}`);
  }
  const results = await pipe.exec();
  const merge = (raw: unknown, failed: boolean) => {
    if (!raw || typeof raw !== 'object') return;
    for (const [field, count] of Object.entries(raw as Record<string, string>)) {
      const [server, instance, username, client_id] = field.split('\x1f');
      if (!server || !instance) continue;
      const edge = edges.get(field) ?? { server, instance, username, client_id, calls: 0, failed: 0 };
      if (failed) edge.failed += Number(count) || 0;
      else edge.calls += Number(count) || 0;
      edges.set(field, edge);
    }
  };
  for (let i = 0; i < windowMinutes; i++) {
    merge(results?.[i * 2]?.[1], false);
    merge(results?.[i * 2 + 1]?.[1], true);
  }
  return edges;
}

/**
 * Read-only topology snapshot for the admin dashboard. Redis sections are
 * best-effort: a section that fails is flagged in `degraded` instead of
 * failing the whole snapshot.
 */
export async function buildTopologySnapshot(windowMinutes: number): Promise<TopologySnapshot> {
  const now = Date.now();
  const [serverRows, instanceRows, health, sessions, flows] = await Promise.all([
    db
      .select({ name: mcpServers.name, displayName: mcpServers.displayName, enabled: mcpServers.enabled })
      .from(mcpServers)
      .orderBy(mcpServers.name),
    db
      .select({
        serverName: mcpServerInstances.serverName,
        url: mcpServerInstances.url,
        enabled: mcpServerInstances.enabled,
      })
      .from(mcpServerInstances),
    collectHealth(now).catch(() => null),
    collectSessions().catch(() => null),
    collectFlows(windowMinutes, now).catch(() => null),
  ]);
  const instancesByServer = new Map<string, typeof instanceRows>();
  for (const row of instanceRows) {
    const list = instancesByServer.get(row.serverName) ?? [];
    list.push(row);
    instancesByServer.set(row.serverName, list);
  }
  const settings = runtimeSettings();
  return {
    generated_at: now,
    window_seconds: windowMinutes * 60,
    monitoring_enabled: settings.monitoring_enabled,
    servers: serverRows.map((server) => ({
      name: server.name,
      display_name: server.displayName,
      enabled: server.enabled,
      instances: (instancesByServer.get(server.name) ?? []).map((instance) => {
        const state = health?.get(instance.url);
        return {
          id: instanceId(instance.url),
          url: instance.url,
          enabled: instance.enabled,
          health: {
            state: !state
              ? ('unknown' as const)
              : state.down === 0
                ? ('up' as const)
                : state.down === state.total
                  ? ('down' as const)
                  : ('degraded' as const),
            replicas_total: state?.total ?? 0,
            replicas_down: state?.down ?? 0,
            last_probe_age_ms: state?.probe ? now - state.probe : null,
          },
        };
      }),
    })),
    sessions: sessions ? [...sessions.values()] : [],
    flows: flows ? [...flows.values()] : [],
    degraded: {
      health: health === null,
      sessions: sessions === null,
      flows: flows === null || !settings.monitoring_enabled,
    },
  };
}
