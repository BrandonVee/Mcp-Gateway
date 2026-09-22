import Fastify from 'fastify';
import { env, serverConfigs } from './config.js';
import { authHook } from './auth.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { redisHealthy } from './lb.js';

const app = Fastify({ logger: true });

// Keep the raw body untouched for every content type: JSON-RPC payloads are
// forwarded byte-for-byte to the upstream instance.
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

app.get('/health', async () => {
  const redis = await redisHealthy();
  return { ok: true, service: 'mcp-gateway', redis };
});

app.get('/servers', async () => {
  return {
    servers: [...serverConfigs.values()].map((s) => ({
      name: s.name,
      instances: s.instances.length,
      url: `/mcp/${s.name}`,
    })),
  };
});

await app.register(async (instance) => {
  instance.addHook('onRequest', authHook);
  registerMcpRoutes(instance);
});

registerMetadataRoutes(app);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info(`gateway routing: ${JSON.stringify([...serverConfigs.entries()].map(([name, c]) => ({ name, instances: c.instances })))}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
