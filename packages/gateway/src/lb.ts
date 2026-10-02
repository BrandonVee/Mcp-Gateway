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

// Keep ownership checks and mutations atomic across Gateway replicas. Refreshes
// may extend an existing binding, but must never recreate or move a session.
const sessionScript = `
local owner = redis.call('GET', KEYS[2])
if ARGV[1] == 'bind' then
  if owner and owner ~= ARGV[2] then return 0 end
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[3])
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
  return 1
end
if owner ~= ARGV[2] or redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if ARGV[1] == 'remove' then
  redis.call('DEL', KEYS[1], KEYS[2])
else
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 1
`;

async function updateSession(action: 'bind' | 'touch' | 'remove', server: string, sessionId: string, owner: string, instanceUrl = ''): Promise<boolean> {
  return Number(await redis.eval(sessionScript, 2, bindKey(server, sessionId), ownerKey(server, sessionId),
    action, owner, env.sessionTtlSeconds, instanceUrl)) === 1;
}

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
    const idx = bound !== null && /^\d+$/.test(bound) ? Number(bound) : -1;
    if (Number.isInteger(idx) && idx >= 0 && idx < cfg.instances.length) {
      return { url: cfg.instances[idx], index: idx, sticky: true };
    }
  }
  const seed = hashSeed ?? String(Date.now());
  const index = createHash('sha256').update(seed).digest()[0] % cfg.instances.length;
  return { url: cfg.instances[index], index, sticky: false };
}

/** Remember which instance created an MCP session without changing its owner. */
export async function bindSession(serverName: string, sessionId: string, instanceUrl: string, owner: string): Promise<void> {
  if (!await updateSession('bind', serverName, sessionId, owner, instanceUrl)) throw new Error('MCP session owner mismatch');
}

/** Extend an existing owned session, including when upstream omits its header. */
export function touchSession(serverName: string, sessionId: string, owner: string): Promise<boolean> {
  return updateSession('touch', serverName, sessionId, owner);
}

/** Forget a terminated upstream session without deleting another user's binding. */
export function removeSession(serverName: string, sessionId: string, owner: string): Promise<boolean> {
  return updateSession('remove', serverName, sessionId, owner);
}
