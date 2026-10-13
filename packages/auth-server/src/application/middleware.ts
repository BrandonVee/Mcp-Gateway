import { systemConfigured } from '@mcp/shared';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { limitRequest } from '../infrastructure/cache/rate-limit.js';
import { refreshSystemSettings } from '../modules/system/settings.js';

/** Order is intentional: request IDs -> setup gate -> payload/CORS -> public endpoint limits. */
export function registerApplicationMiddleware(app: Hono): void {
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const start = performance.now();
    c.header('X-Request-Id', requestId);
    let failed = false;
    try {
      await next();
    } catch (error) {
      failed = true;
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'auth',
          request_id: requestId,
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw error;
    } finally {
      // Do not log query strings, headers or bodies: OAuth URLs can contain codes.
      if (c.req.path !== '/health' && c.req.path !== '/live') {
        console.log(
          JSON.stringify({
            level: failed ? 'error' : 'info',
            service: 'auth',
            request_id: requestId,
            method: c.req.method,
            path: c.req.path,
            status: failed ? 500 : c.res.status,
            duration_ms: Math.round(performance.now() - start),
          }),
        );
      }
    }
  });
  app.use('*', async (c, next) => {
    if (!['/live', '/health'].includes(c.req.path)) {
      try {
        await refreshSystemSettings();
      } catch {
        return c.json({ error: 'system_settings_unavailable' }, 503);
      }
      if (
        !systemConfigured() &&
        // The shared browser login must remain reachable so an administrator can
        // sign in and finish setup before OAuth and personal MCP access open.
        c.req.path !== '/me/session' &&
        (/^\/(authorize(?:\/|$)|token$|register$|me(?:\/|$)|oauth(?:\/|$))/.test(c.req.path) ||
          c.req.path.startsWith('/.well-known/'))
      )
        return c.json({ error: 'system_not_configured' }, 503);
    }
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  app.use(
    '*',
    cors({
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization', 'x-session-identity'],
      credentials: true,
    }),
  );

  const publicPostLimits: Record<string, [number, number]> = {
    '/authorize/submit': [30, 60],
    '/authorize/signup': [10, 3600],
    '/admin/session': [20, 60],
    '/me/session': [20, 60],
    // Separate from /authorize/signup: one address may create twice as many accounts.
    '/me/signup': [10, 3600],
    '/me/signup/send-code': [10, 3600],
    '/me/email/send-code': [10, 3600],
    '/me/email/verify': [20, 3600],
    '/token': [120, 60],
    '/register': [20, 60],
  };
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST') {
      const policy = publicPostLimits[c.req.path];
      if (policy) {
        let allowed: boolean;
        try {
          allowed = await limitRequest(c, c.req.path, policy[0], policy[1]);
        } catch {
          return c.json({ error: 'rate_limit_unavailable' }, 503);
        }
        if (!allowed) {
          c.header('Retry-After', String(policy[1]));
          console.warn(
            JSON.stringify({ level: 'warn', service: 'auth', event: 'rate_limit_exceeded', path: c.req.path }),
          );
          return c.json({ error: 'rate_limit_exceeded' }, 429);
        }
      }
    }
    if (
      [
        '/authorize',
        '/authorize/submit',
        '/authorize/signup',
        '/token',
        '/admin/session',
        '/me/session',
        '/me/signup',
        '/register',
      ].includes(c.req.path)
    ) {
      c.header('Cache-Control', 'no-store');
    }
    await next();
  });
}
