import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { applySystemSettings, currentSystemSettings } from '@/shared/index.js';
import { registryStatus, serverConfigs, refreshServerConfigs } from '@/gateway/config.js';
import { registerRequestPolicy } from '@/gateway/routes/request-policy.js';

const Fastify = createRequire(new URL('../packages/gateway/package.json', import.meta.url))('fastify');

test('preflight observes a changed public URL immediately while ordinary requests reuse the registry', async (t) => {
  const previous = currentSystemSettings(),
    mode = process.env.SYSTEM_CONFIG_MODE,
    nodeEnv = process.env.NODE_ENV,
    servers = new Map(serverConfigs),
    status = { ...registryStatus };
  process.env.SYSTEM_CONFIG_MODE = 'database';
  process.env.NODE_ENV = 'production';
  const app = Fastify();
  registerRequestPolicy(app);
  app.route({ method: ['POST', 'OPTIONS'], url: '/mcp/policy', handler: async () => ({ ok: true }) });
  let publicUrl = 'https://old.example.test',
    requests = 0,
    unavailable = false;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (unavailable) return new Response(null, { status: 503 });
    return Response.json({
      servers: [],
      system_settings: { public_url: publicUrl, upstream_allowlist_enabled: true, upstream_hosts: [] },
    });
  });
  const send = (method: 'POST' | 'OPTIONS', origin = publicUrl) =>
    app.inject({ method, url: '/mcp/policy', headers: { origin } });
  try {
    await refreshServerConfigs();
    const oldUrl = publicUrl;
    assert.equal((await send('POST')).statusCode, 200);
    publicUrl = 'https://new.example.test';
    assert.equal(requests, 1, 'ordinary requests reuse the fresh snapshot');
    const preflight = await send('OPTIONS');
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], publicUrl);
    assert.equal(requests, 2, 'preflight refreshes settings even within the cache interval');
    assert.equal((await send('POST', oldUrl)).statusCode, 403);
    assert.equal((await send('POST')).statusCode, 200);
    assert.equal(requests, 2);

    applySystemSettings({ public_url: null, upstream_allowlist_enabled: true, upstream_hosts: [] });
    assert.equal((await send('POST')).statusCode, 200, 'initial setup is observed without waiting for the cache');
    assert.equal(requests, 3);
    unavailable = true;
    const failed = await send('OPTIONS');
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error, 'system_settings_unavailable');
    assert.equal(failed.headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
    applySystemSettings(previous);
    serverConfigs.clear();
    for (const [key, value] of servers) serverConfigs.set(key, value);
    Object.assign(registryStatus, status);
    if (mode === undefined) delete process.env.SYSTEM_CONFIG_MODE;
    else process.env.SYSTEM_CONFIG_MODE = mode;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
});
