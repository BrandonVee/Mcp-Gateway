import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { McpServerConfig } from '@mcp/shared';
import { env } from './config.js';

const redis = new Redis(env.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export { redis };

const bindKey = (server: string, sessionId: string): string => `gw:bind:${server}:${sessionId}`;
const ownerKey = (server: string, sessionId: string): string => `gw:owner:${server}:${sessionId}`;

export async function sessionOwnedBy(serverName: string, sessionId: string, owner: string): Promise<boolean> {
  return (await redis.get(ownerKey(serverName, sessionId))) === owner;
}

// (initial placement is a pure function of the request -> safe under concurrent replicas)

export interface PickedInstance {
  url: string;
  index: number;
  sticky: boolean;
}

/**
 * Choose an instance for a request.
 * - If the MCP session is already bound to an instance (Redis), keep it there.
 * - Otherwise place deterministically: hash of the request payload. This is a
 *   pure function, so concurrent gateway replicas agree without coordination,
 *   and duplicated initialize requests land on the same instance.
 */
export async function pickInstance(cfg: McpServerConfig, sessionId?: string, hashSeed?: string): Promise<PickedInstance> {
  if (sessionId) {
    const bound = await redis.get(bindKey(cfg.name, sessionId));
    const urlIndex = bound ? cfg.instances.indexOf(bound) : -1;
    if (urlIndex >= 0) return { url: cfg.instances[urlIndex], index: urlIndex, sticky: true };
    // Backward compatibility with bindings written by the old index format.
    const idx = Number(bound);
    if (Number.isInteger(idx) && idx >= 0 && idx < cfg.instances.length) {
      return { url: cfg.instances[idx], index: idx, sticky: true };
    }
  }
  const seed = hashSeed ?? String(Date.now());
  const index = createHash('sha256').update(seed).digest()[0] % cfg.instances.length;
  return { url: cfg.instances[index], index, sticky: false };
}

/** Remember which instance owns an MCP session (with TTL refresh on every request). */
export async function bindSession(serverName: string, sessionId: string, instanceUrl: string, owner: string): Promise<void> {
  const existingOwner = await redis.get(ownerKey(serverName, sessionId));
  if (existingOwner && existingOwner !== owner) throw new Error('MCP session owner mismatch');
  await redis.multi()
    .set(bindKey(serverName, sessionId), instanceUrl, 'EX', env.sessionTtlSeconds)
    .set(ownerKey(serverName, sessionId), owner, 'EX', env.sessionTtlSeconds)
    .exec();
}
