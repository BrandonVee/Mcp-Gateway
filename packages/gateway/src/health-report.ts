import { randomUUID } from 'node:crypto';
import { serverConfigs } from './config.js';
import { redis } from './lb.js';
import { upstreamHealth } from './upstream-health.js';

const replicaId = randomUUID();
const healthKey = `gw:health:${replicaId}`;

/**
 * Publish this replica's upstream health view to Redis so the auth server can
 * aggregate a cross-replica topology. Every registered URL is written (0 when
 * healthy) so "no cooldown" stays distinguishable from "not reporting".
 */
export async function publishHealthSnapshot(): Promise<void> {
  const urls = [...new Set([...serverConfigs.values()].flatMap((server) => server.instances))];
  if (!urls.length) return;
  const state = upstreamHealth.snapshot();
  const probedAt = Date.now();
  const hash: Record<string, string> = {};
  for (const url of urls) {
    const entry = state[url];
    hash[url] = JSON.stringify({
      t: entry?.transport_until ?? 0,
      h: entry?.http_until ?? 0,
      p: probedAt,
    });
  }
  await redis.hset(healthKey, hash);
  await redis.expire(healthKey, 45);
}
