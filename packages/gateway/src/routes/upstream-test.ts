import { bearerTokenMatches } from '@/shared/security/bearer.js';
import type { FastifyInstance } from 'fastify';
import type { UpstreamEndpointValidation } from '@mcp/shared';
import { unavailableUpstreamTest, upstreamTestCredentialSchema } from '@mcp/shared';
import { testUpstreamMcp } from '@/gateway/upstream-test.js';
import { upstreamHealth } from '@/gateway/upstream-health.js';

export function registerUpstreamTestRoute(
  app: FastifyInstance,
  options: {
    token: string;
    refreshPolicy: () => Promise<void>;
    validate: (url: unknown) => UpstreamEndpointValidation | { error: 'gateway_self_referential_endpoint' };
    probe?: typeof testUpstreamMcp;
  },
) {
  let active = 0;
  app.post('/internal/upstream-test', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!bearerTokenMatches(req.headers.authorization, options.token))
      return reply.code(401).send({ error: 'invalid_internal_token' });
    if (active >= 4) return unavailableUpstreamTest('busy');
    active++;
    try {
      await options.refreshPolicy();
      let body: unknown = req.body;
      if (Buffer.isBuffer(body)) {
        try {
          body = JSON.parse(body.toString());
        } catch {
          body = null;
        }
      }
      const endpoint = options.validate(body && typeof body === 'object' ? (body as { url?: unknown }).url : undefined);
      if (endpoint.error) return reply.code(400).send(endpoint);
      const rawCredential =
        body && typeof body === 'object' ? (body as { credential?: unknown }).credential : undefined;
      const credential =
        rawCredential === undefined ? undefined : upstreamTestCredentialSchema.safeParse(rawCredential);
      if (credential && !credential.success) return reply.code(400).send({ error: 'invalid_probe_credentials' });
      const result = credential?.success
        ? await (options.probe ?? testUpstreamMcp)(endpoint.url, 8_000, credential.data)
        : await (options.probe ?? testUpstreamMcp)(endpoint.url);
      if (result.ok) upstreamHealth.recordSuccess(endpoint.url);
      return result;
    } catch {
      return unavailableUpstreamTest('gateway_unavailable');
    } finally {
      active--;
    }
  });
}
