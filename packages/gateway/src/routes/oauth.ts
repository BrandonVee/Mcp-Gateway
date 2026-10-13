import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request } from 'undici';
import { filterResponseHeaders } from '@/gateway/routes/headers.js';

/** Local clients may discover OAuth on the MCP origin before following RFC 9728. */
export function registerDevelopmentOAuthRoutes(
  app: FastifyInstance,
  options: {
    authUrl: string;
    authIssuer: () => string;
    production: boolean;
  },
): void {
  // Production ingress already routes these endpoints directly to Auth.
  if (options.production) return;
  const proxy = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0];
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'accept'] as const) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    try {
      const response = await request(new URL(path, options.authUrl), {
        method: req.method === 'POST' ? 'POST' : 'GET',
        headers,
        body: req.method === 'POST' ? (req.body as Buffer) : undefined,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      reply.headers(filterResponseHeaders(response.headers));
      reply.header('Cache-Control', 'no-store');
      return reply.code(response.statusCode).send(response.body);
    } catch {
      return reply.code(503).send({ error: 'authorization_server_unavailable' });
    }
  };
  app.get('/.well-known/oauth-authorization-server', proxy);
  app.get('/.well-known/openid-configuration', proxy);
  app.get('/jwks.json', proxy);
  app.post('/register', proxy);
  app.post('/token', proxy);
  app.get('/authorize', (req, reply) => {
    const destination = new URL(req.url, options.authIssuer());
    return reply.code(307).header('Location', destination.toString()).send();
  });
}
