import type { FastifyInstance } from 'fastify';
import { databaseSettingsEnabled, systemConfigured } from '@mcp/shared';
import { env, refreshServerConfigs } from '@/gateway/config.js';

/**
 * Protected Resource Metadata (RFC 9728): tells MCP clients which
 * authorization server to use and where token validation happens.
 */
export function registerMetadataRoutes(app: FastifyInstance): void {
  const base = () => env.resourceBaseUrl.replace(/\/+$/, '');
  const ready = async () => {
    if (databaseSettingsEnabled()) {
      try {
        await refreshServerConfigs();
      } catch {
        return false;
      }
    }
    return systemConfigured();
  };
  const metadata = (resource: string) => ({
    resource,
    authorization_servers: [env.authIssuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base()}/`,
  });

  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'system_not_configured' });
    return reply.send(metadata(base()));
  });

  // RFC 9728 path form for a protected resource such as /mcp/demo.
  app.get('/.well-known/oauth-protected-resource/mcp/:serverName', async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'system_not_configured' });
    const { serverName } = req.params as { serverName: string };
    return reply.send(metadata(`${base()}/mcp/${encodeURIComponent(serverName)}`));
  });
}
