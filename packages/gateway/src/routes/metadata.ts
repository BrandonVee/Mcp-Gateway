import type { FastifyInstance } from 'fastify';
import { env } from '../config.js';

/**
 * Protected Resource Metadata (RFC 9728): tells MCP clients which
 * authorization server to use and where token validation happens.
 */
export function registerMetadataRoutes(app: FastifyInstance): void {
  const base = env.resourceBaseUrl.replace(/\/+$/, '');
  const metadata = {
    resource: base,
    authorization_servers: [env.authIssuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/`,
  };

  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    return reply.send(metadata);
  });
}
