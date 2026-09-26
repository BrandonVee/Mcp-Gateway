import Fastify from 'fastify';
import { env, refreshServerConfigs, registryStatus, serverConfigs, startRegistryRefresh } from './config.js';
import { authHook, hasServerAccess } from './auth.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { redisHealthy } from './lb.js';
import { isAllowedMcpOrigin, mcpCorsHeaders } from './routes/origin.js';

const app = Fastify({
  logger: {
    serializers: {
      req(req) {
        // Keep OAuth codes and tokens in query strings out of request logs.
        return { method: req.method, path: req.url?.split('?')[0], remoteAddress: req.ip };
      },
    },
  },
});

// Keep the raw body untouched for every content type: JSON-RPC payloads are
// forwarded byte-for-byte to the upstream instance.
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

app.get('/live', async () => ({ ok: true, service: 'mcp-gateway' }));

app.get('/health', async (_req, reply) => {
  const redis = await redisHealthy();
  const registryReady = Boolean(registryStatus.lastSuccessAt && !registryStatus.lastError
    && Date.now() - registryStatus.lastSuccessAt <= Math.max(60, env.registryRefreshSeconds * 3) * 1000);
  const ok = redis && registryReady;
  return reply.code(ok ? 200 : 503).send({ ok, service: 'mcp-gateway', redis, registry: registryStatus });
});

await app.register(async (instance) => {
  instance.addHook('onRequest', async (req, reply) => {
    if (!req.url.split('?')[0].startsWith('/mcp/')) return;
    if (!isAllowedMcpOrigin(req.headers.origin, env.resourceBaseUrl)) {
      await reply.code(403).send({ error: 'invalid_origin' });
      return;
    }
    for (const [name, value] of Object.entries(mcpCorsHeaders(req.headers.origin, env.resourceBaseUrl))) reply.header(name, value);
    if (req.method === 'OPTIONS' && req.headers.origin) await reply.code(204).send();
  });
  instance.addHook('onRequest', authHook);
  instance.get('/servers', async (req) => ({
    servers: [...serverConfigs.values()]
      .filter((server) => hasServerAccess(req.mcpAuth, server.name))
      .map((server) => ({
        name: server.name,
        instances: server.instances.length,
        url: `/mcp/${server.name}`,
      })),
  }));
  registerMcpRoutes(instance);
});

registerMetadataRoutes(app);

const start = async (): Promise<void> => {
  try {
    // Auth may briefly restart during development or deploy. Wait for its
    // database-backed registry rather than serving a static fallback.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await refreshServerConfigs();
        break;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        app.log.warn({ err }, 'registry unavailable during startup; retrying');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    startRegistryRefresh((err) => app.log.warn({ err }, 'server registry refresh failed'));
    await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info({ servers: [...serverConfigs.keys()] }, 'gateway routing ready');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
