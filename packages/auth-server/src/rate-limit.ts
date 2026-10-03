import { createHash } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { Redis } from 'ioredis';
import { loadPlatformConfig } from '@mcp/shared';
import { resolveClientIp } from './client-ip.js';

const redis = new Redis(process.env.REDIS_URL ?? loadPlatformConfig().gateway.redisUrl, {
  maxRetriesPerRequest: 1,
  connectTimeout: 3_000,
});
redis.on('error', (error) => console.error('[auth-rate-limit] redis error', error.name));

const INCREMENT_WITH_EXPIRY = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

function clientIp(c: Context): string {
  const socket = getConnInfo(c).remote.address ?? 'unknown';
  return resolveClientIp(socket, c.req.header('x-forwarded-for'), process.env.AUTH_TRUSTED_PROXY_IPS ?? '');
}

/** Shared Redis counters apply the same fixed-window limit across Auth replicas. */
export async function consumeRateLimit(
  bucket: string,
  identity: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const digest = createHash('sha256').update(identity).digest('hex');
  const count = Number(await redis.eval(INCREMENT_WITH_EXPIRY, 1, `auth:rl:${bucket}:${digest}`, windowSeconds));
  return count <= limit;
}

export async function limitRequest(c: Context, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  return consumeRateLimit(bucket, clientIp(c), limit, windowSeconds);
}

export async function limitLoginAccount(username: string): Promise<boolean> {
  return consumeRateLimit('login-account', username.trim().toLowerCase(), 30, 15 * 60);
}

export async function rateLimitHealthy(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
