import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { UpstreamEndpointValidation } from '@mcp/shared';
import { unavailableUpstreamTest } from '@mcp/shared';
import { testUpstreamMcp } from '../upstream-test.js';
import { upstreamHealth } from '../upstream-health.js';

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
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(options.token);
    if (
      !req.headers.authorization?.startsWith('Bearer ') ||
      !expected.length ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
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
      const result = await (options.probe ?? testUpstreamMcp)(endpoint.url);
      if (result.ok) upstreamHealth.recordSuccess(endpoint.url);
      return result;
    } catch {
      return unavailableUpstreamTest('gateway_unavailable');
    } finally {
      active--;
    }
  });
}
