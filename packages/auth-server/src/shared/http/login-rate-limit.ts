import type { Context } from 'hono';
import { limitLoginAccount } from '@/auth/infrastructure/cache/rate-limit.js';

/** Fail closed if Redis is unavailable; share account throttling across both login surfaces. */
export async function enforceLoginAccountLimit(c: Context, username: unknown): Promise<Response | null> {
  if (typeof username !== 'string' || !username.trim()) return null;
  try {
    if (!(await limitLoginAccount(username))) {
      c.header('Retry-After', '900');
      return c.json({ error: 'rate_limit_exceeded' }, 429);
    }
  } catch {
    return c.json({ error: 'rate_limit_unavailable' }, 503);
  }
  return null;
}
