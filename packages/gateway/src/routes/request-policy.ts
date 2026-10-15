import type { FastifyInstance } from 'fastify';
import { databaseSettingsEnabled, systemConfigured } from '@mcp/shared';
import { env, ensureServerConfigsFresh, refreshServerConfigs } from '@/gateway/config.js';
import { isAllowedMcpOrigin, mcpCorsHeaders } from '@/gateway/routes/origin.js';

/** Browser preflight and initial setup must observe settings saved moments ago. */
export function registerRequestPolicy(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (databaseSettingsEnabled() && (path.startsWith('/mcp') || path === '/servers')) {
      try {
        if (req.method === 'OPTIONS' || !systemConfigured()) await refreshServerConfigs();
        else await ensureServerConfigsFresh();
      } catch {
        return reply.code(503).send({ error: 'system_settings_unavailable' });
      }
      if (!systemConfigured()) return reply.code(503).send({ error: 'system_not_configured' });
    }
    if (!path.startsWith('/mcp/')) return;
    if (!isAllowedMcpOrigin(req.headers.origin, env.resourceBaseUrl)) {
      await reply.code(403).send({ error: 'invalid_origin' });
      return;
    }
    for (const [name, value] of Object.entries(mcpCorsHeaders(req.headers.origin, env.resourceBaseUrl)))
      reply.header(name, value);
    if (req.method === 'OPTIONS' && req.headers.origin) await reply.code(204).send();
  });
}
