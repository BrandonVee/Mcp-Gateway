import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  env,
  registryStatus,
  serverConfigs,
  refreshServerConfigs,
  ensureServerConfigsFresh,
} from '@/gateway/config.js';

test('registry traffic shares refreshes, reuses fresh snapshots, and validates ETags without losing routing policy', async (t) => {
  const previousMode = process.env.SYSTEM_CONFIG_MODE;
  process.env.SYSTEM_CONFIG_MODE = 'file';
  const previous = new Map(serverConfigs),
    status = { ...registryStatus };
  let requests = 0,
    release!: () => void,
    conditional = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    requests++;
    await gate;
    if (conditional) {
      assert.equal(options.headers['if-none-match'], '"registry-v1"');
      return new Response(null, { status: 304 });
    }
    return Response.json(
      {
        servers: [
          {
            name: 'cache-test',
            authMode: 'none',
            monitoringLogsEnabled: true,
            userLimits: { perMinute: 120, daily: 1000, concurrent: 5 },
            instances: [{ id: 'cache-upstream', url: 'http://cache.test/mcp' }],
          },
        ],
      },
      { headers: { etag: '"registry-v1"' } },
    );
  });
  try {
    const refreshes = Array.from({ length: 20 }, () => refreshServerConfigs());
    release();
    await Promise.all(refreshes);
    assert.equal(requests, 1);
    const snapshot = serverConfigs.get('cache-test');
    assert.equal(snapshot?.monitoringLogsEnabled, true);
    assert.deepEqual(snapshot?.userLimits, { perMinute: 120, daily: 1000, concurrent: 5 });
    await Promise.all(Array.from({ length: 20 }, () => ensureServerConfigsFresh()));
    assert.equal(requests, 1, 'fresh requests must not refetch the entire registry');
    conditional = true;
    const now = Date.now() + Math.max(1, env.registryRefreshSeconds) * 1000 + 1;
    t.mock.method(Date, 'now', () => now);
    await Promise.all(Array.from({ length: 20 }, () => ensureServerConfigsFresh()));
    assert.equal(requests, 2);
    assert.equal(serverConfigs.get('cache-test'), snapshot, '304 retains the validated snapshot');
    assert.equal(registryStatus.lastSuccessAt, now);
  } finally {
    serverConfigs.clear();
    for (const [key, value] of previous) serverConfigs.set(key, value);
    Object.assign(registryStatus, status);
    if (previousMode === undefined) delete process.env.SYSTEM_CONFIG_MODE;
    else process.env.SYSTEM_CONFIG_MODE = previousMode;
  }
});
