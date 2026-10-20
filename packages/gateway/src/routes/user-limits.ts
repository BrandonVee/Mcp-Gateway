import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { McpServerConfig } from '@mcp/shared';

const reserve = `
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local daily = tonumber(ARGV[3])
local concurrent = tonumber(ARGV[4])
if rate > 0 and tonumber(redis.call('GET',KEYS[1]) or '0') >= rate then return {1,ARGV[6]} end
local tools = tonumber(ARGV[8])
if daily > 0 and tools > 0 and tonumber(redis.call('GET',KEYS[2]) or '0') + tools > daily then return {2,ARGV[7]} end
if concurrent > 0 then
  redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now)
  if redis.call('ZCARD',KEYS[3]) >= concurrent then return {3,1} end
end
if rate > 0 then redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],ARGV[6]) end
if daily > 0 and tools > 0 then redis.call('INCRBY',KEYS[2],tools); redis.call('EXPIRE',KEYS[2],ARGV[7]) end
if concurrent > 0 then redis.call('ZADD',KEYS[3],now+60000,ARGV[5]); redis.call('EXPIRE',KEYS[3],120) end
return {0,0}
`;
const renew = `
if redis.call('ZSCORE',KEYS[1],ARGV[1]) then
  redis.call('ZADD',KEYS[1],ARGV[2],ARGV[1]); redis.call('EXPIRE',KEYS[1],120); return 1
end
return 0
`;
export type UserPermit = { release: () => Promise<void> } | { error: string; retryAfter: number };

/** Atomic user/service limits shared across replicas. Daily quotas count admitted tool attempts, in UTC. */
export async function reserveUserRequest(
  redis: Pick<Redis, 'eval' | 'zrem'>,
  server: McpServerConfig,
  userId: number | string,
  toolCalls = 0,
  now = Date.now(),
): Promise<UserPermit> {
  const limits = server.userLimits;
  if (!limits || !Object.values(limits).some((value) => value > 0)) return { release: async () => {} };
  const identity = createHash('sha256')
    .update(JSON.stringify([server.name, userId]))
    .digest('hex');
  const prefix = `gw:limits:${identity}`;
  const active = `${prefix}:active`,
    token = randomUUID();
  const minute = Math.floor(now / 60_000),
    day = Math.floor(now / 86_400_000);
  const minuteTtl = Math.ceil(((minute + 1) * 60_000 - now) / 1000);
  const dayTtl = Math.ceil(((day + 1) * 86_400_000 - now) / 1000);
  const result = (await redis.eval(
    reserve,
    3,
    `${prefix}:minute:${minute}`,
    `${prefix}:day:${day}`,
    active,
    now,
    limits.perMinute,
    limits.daily,
    limits.concurrent,
    token,
    minuteTtl,
    dayTtl,
    toolCalls,
  )) as [number, number];
  const code = Number(result[0]);
  if (code !== 0)
    return {
      error: ['user_rate_limit_exceeded', 'user_daily_quota_exceeded', 'user_concurrency_limit_exceeded'][code - 1],
      retryAfter: Number(result[1]),
    };
  let released = false;
  const heartbeat =
    limits.concurrent > 0
      ? setInterval(() => {
          void redis.eval(renew, 1, active, token, Date.now() + 60_000).catch(() => undefined);
        }, 15_000)
      : undefined;
  heartbeat?.unref();
  return {
    release: async () => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      if (limits.concurrent > 0) await redis.zrem(active, token);
    },
  };
}
