/** Run with local database/Redis configuration; all writes use a disposable schema. */
import assert from 'node:assert/strict';
import { createIsolatedAuthSchema } from '@/scripts/isolated-auth-schema.js';

async function main() {
  const isolated = await createIsolatedAuthSchema();
  process.env.DATABASE_URL = isolated.databaseUrl;
  process.env.SYSTEM_CONFIG_MODE = 'database';
  process.env.NODE_ENV = 'development';
  const { db, pool } = await import('@/auth/infrastructure/database/client.js');
  const { createLoginSession } = await import('@/auth/modules/identity/sessions.js');
  try {
    const { users } = await import('@/auth/infrastructure/database/schema.js');
    const { saveSystemSettings, refreshSystemSettings } = await import('@/auth/modules/system/settings.js');
    const { createAdminRouter } = await import('@/auth/modules/admin/router.js');
    const { loadSigningKeys } = await import('@/auth/modules/oauth/keys.js');
    const settings = {
      public_url: 'https://gateway.example.test',
      upstream_allowlist_enabled: true,
      upstream_hosts: ['trusted.example.test'],
      registration_enabled: false,
      monitoring_enabled: false,
      monitoring_slow_ms: 1234,
    };
    await saveSystemSettings(settings);
    const [admin, user] = await db
      .insert(users)
      .values([
        {
          username: 'allowlist-admin',
          passwordHash: 'unused',
          role: 'admin',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          username: 'allowlist-user',
          passwordHash: 'unused',
          role: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ])
      .returning();
    const adminToken = await createLoginSession(admin.id, 0);
    const userToken = await createLoginSession(user.id, 0);
    const app = createAdminRouter({ keys: await loadSigningKeys(), issuer: 'http://localhost:9001' });
    const request = async (
      path: string,
      method = 'GET',
      body?: unknown,
      token = adminToken,
      origin = 'http://localhost:5173',
    ) => {
      const response = await app.request(path, {
        method,
        headers: {
          cookie: `auth_session=${token}`,
          origin,
          'content-type': 'application/json',
          'x-session-identity': `${token === userToken ? user.id : admin.id}:0`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as any };
    };
    const register = () =>
      request('/admin/servers', 'POST', {
        name: 'allowlist-test',
        instances: [{ url: 'http://mcp-a:8765/mcp/fx' }],
      });
    assert.deepEqual(await register(), { status: 400, data: { error: 'upstream_host_not_allowed', host: 'mcp-a' } });
    const add = (host: unknown, token = adminToken, origin?: string) =>
      request('/admin/system-settings/upstream-hosts', 'POST', { host }, token, origin);
    assert.equal((await add('mcp-a', userToken)).status, 403);
    assert.equal((await add('mcp-a', adminToken, 'https://attacker.example.test')).status, 403);
    for (const invalid of [null, 42, '', 'https://mcp-a', 'mcp-a:8765', 'mcp-a/mcp'])
      assert.equal((await add(invalid)).status, 400);
    const added = await add(' MCP-A ');
    assert.equal(added.status, 200);
    assert.deepEqual(added.data.upstream_hosts, ['mcp-a', 'trusted.example.test']);
    for (const key of ['public_url', 'registration_enabled', 'monitoring_enabled', 'monitoring_slow_ms'] as const)
      assert.equal(added.data[key], settings[key]);
    assert.equal((await register()).status, 201);
    const instance = await request('/admin/servers/allowlist-test/instances', 'POST', {
      url: 'https://other.example.test/mcp',
    });
    assert.equal(instance.status, 400);
    assert.equal(instance.data.error, 'upstream_host_not_allowed');
    const savedServer = (await request('/admin/servers')).data.servers[0];
    const edit = await request(`/admin/servers/allowlist-test/instances/${savedServer.instances[0].id}`, 'PATCH', {
      url: 'https://other.example.test/mcp',
    });
    assert.equal(edit.status, 400);
    assert.equal(edit.data.error, 'upstream_host_not_allowed');
    const concurrent = await Promise.all(['one.example.test', 'two.example.test', 'mcp-a'].map((host) => add(host)));
    assert.ok(concurrent.every((result) => result.status === 200));
    await refreshSystemSettings();
    assert.deepEqual((await request('/admin/system-settings')).data.upstream_hosts, [
      'mcp-a',
      'one.example.test',
      'trusted.example.test',
      'two.example.test',
    ]);
    await saveSystemSettings({
      ...settings,
      upstream_hosts: Array.from({ length: 200 }, (_, i) => `host-${i}.example.test`),
    });
    assert.equal((await add('host-0.example.test')).status, 200, 'duplicates at the limit remain idempotent');
    assert.deepEqual(await add('overflow.example.test'), {
      status: 400,
      data: { error: 'upstream_host_limit_reached' },
    });
    assert.equal((await request('/admin/system-settings')).data.upstream_hosts.length, 200);
    process.env.SYSTEM_CONFIG_MODE = 'file';
    assert.deepEqual(await add('mcp-a'), { status: 409, data: { error: 'system_settings_managed_by_environment' } });
    console.log(
      'PASS: blocked registration, quick-add, successful retry, instance validation, settings preservation, concurrent append, limits and admin/origin guards',
    );
  } finally {
    await pool.end();
    await isolated.cleanup();
  }
}

// Imported services keep Redis connections open; exit after database cleanup.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
