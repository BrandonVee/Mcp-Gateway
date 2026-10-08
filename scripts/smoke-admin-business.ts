/** Verify admin workflows using a disposable database schema. */
import assert from 'node:assert/strict';
import { createIsolatedAuthSchema } from './isolated-auth-schema.js';
import { authFields } from '../packages/admin-web/src/features/servers/ServerDialogs';

async function main() {
  const isolated = await createIsolatedAuthSchema();
  process.env.DATABASE_URL = isolated.databaseUrl;
  process.env.SYSTEM_CONFIG_MODE = 'database';
  process.env.NODE_ENV = 'development';
  process.env.CREDENTIAL_ENCRYPT_KEY = 'a'.repeat(64);
  const { db, pool, createLoginSession } = await import('../packages/auth-server/src/db.js');
  try {
    const { users, mcpServers, userMcpCredentials } = await import('../packages/auth-server/src/schema.js');
    const { saveSystemSettings } = await import('../packages/auth-server/src/system-settings.js');
    const { createAdminRouter } = await import('../packages/auth-server/src/admin.js');
    const { createConnectionsRouter } = await import('../packages/auth-server/src/connections.js');
    const { loadSigningKeys } = await import('../packages/auth-server/src/keys.js');
    await saveSystemSettings({
      public_url: 'https://gateway.example.test',
      upstream_allowlist_enabled: false,
      upstream_hosts: [],
    });
    const [admin] = await db
      .insert(users)
      .values({
        username: 'workflow-admin',
        passwordHash: 'unused',
        role: 'admin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning();
    const token = await createLoginSession(admin.id, 0);
    const keys = await loadSigningKeys();
    const app = createAdminRouter({ keys, issuer: 'http://localhost:9001' });
    app.route('/', createConnectionsRouter());
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await app.request(path, {
        method,
        headers: {
          cookie: `auth_session=${token}`,
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
          'x-session-identity': `${admin.id}:0`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as any };
    };
    const user = { username: 'workflow-user@example.test', password: 'workflow-password', role: 'user', servers: [] };
    for (const body of [
      null,
      { ...user, username: 'bad/name' },
      { ...user, username: 'a'.repeat(65) },
      { ...user, password: 42 },
      { ...user, password: 'a'.repeat(257) },
      { ...user, role: 'invalid' },
    ])
      assert.equal((await request('/admin/users', 'POST', body)).status, 400, 'malformed user creation must not throw');
    const created = await request('/admin/users', 'POST', { ...user, username: ' workflow-user@example.test ' });
    assert.equal(created.status, 201);
    assert.equal(created.data.username, 'workflow-user@example.test');
    assert.equal((await request('/admin/users', 'POST', user)).status, 409);
    const createServer = (name: string, extra: object = {}) =>
      request('/admin/servers', 'POST', {
        name,
        instances: [{ id: `${name}-instance`, url: 'http://mcp-a:8765/mcp' }],
        ...extra,
      });
    assert.equal((await createServer('paused')).status, 201);
    assert.equal((await request('/admin/servers/paused', 'PATCH', { enabled: false })).status, 200);
    const grants = `/admin/users/${created.data.id}/servers`;
    assert.equal((await request(grants, 'PUT', { servers: ['paused'] })).status, 200);
    assert.deepEqual((await request(grants)).data.servers, ['paused']);
    const unknown = await request(grants, 'PUT', { servers: ['deleted'] });
    assert.deepEqual(unknown, { status: 400, data: { error: 'unknown_server', server: 'deleted' } });
    assert.deepEqual((await request(grants)).data.servers, ['paused'], 'failed edit preserves prior grants');
    assert.equal((await request('/admin/servers/paused', 'PATCH', { enabled: true })).status, 200);
    assert.deepEqual((await request(grants)).data.servers, ['paused'], 'reactivating a service retains its grants');
    assert.equal(
      (await request('/admin/servers/paused/instances', 'POST', { id: 'paused-instance', url: 'http://mcp-a/mcp' }))
        .status,
      409,
    );
    assert.equal(
      (await createServer('duplicate', { instances: [{ id: 'paused-instance', url: 'http://mcp-a/mcp' }] })).status,
      409,
    );
    assert.ok(
      !(await request('/admin/servers')).data.servers.some((server: any) => server.name === 'duplicate'),
      'failed registration rolls back the service',
    );
    for (const body of [
      null,
      { url: 42 },
      { id: 42, url: 'http://mcp-a/mcp' },
      { id: 'x'.repeat(257), url: 'http://mcp-a/mcp' },
    ])
      assert.equal((await request('/admin/servers/paused/instances', 'POST', body)).status, 400);
    assert.equal(
      (await request('/admin/servers/paused/instances/paused-instance', 'PATCH', { enabled: 'false' })).status,
      400,
    );
    assert.equal((await request('/admin/servers')).data.servers[0].instances[0].enabled, true);
    assert.equal(
      (
        await createServer('oauth-invalid', {
          auth_mode: 'oauth',
          oauth_authorize_url: 'http://provider.test/authorize',
          oauth_token_url: 'https://provider.test/token',
          oauth_client_id: 'client',
        })
      ).status,
      400,
    );
    const oauth = {
      auth_mode: 'oauth' as const,
      oauth_authorize_url: 'https://provider.test/authorize',
      oauth_token_url: 'https://provider.test/token',
      oauth_client_id: 'client',
      oauth_client_auth_method: 'client_secret_basic' as const,
      oauth_client_secret: 'test-client-secret',
    };
    assert.equal((await createServer('oauth', oauth)).status, 201);
    const dto = (await request('/admin/servers')).data.servers.find((server: any) => server.name === 'oauth');
    assert.equal(dto.oauth_client_secret_configured, true);
    assert.ok(!JSON.stringify(dto).includes('test-client-secret'));
    assert.ok(!Object.hasOwn(dto, 'oauth_client_secret'));
    // Older versions stored empty scopes as an empty string instead of NULL.
    await pool.query('UPDATE mcp_servers SET oauth_scopes = $1 WHERE name = $2', ['', 'oauth']);
    const before = (await db.select().from(mcpServers)).find((server) => server.name === 'oauth')!;
    await db.insert(userMcpCredentials).values({
      userId: admin.id,
      serverName: 'oauth',
      mode: 'oauth',
      secret: 'test-opaque-token',
      updatedAt: Date.now(),
    });
    const edit = authFields({
      ...oauth,
      oauth_client_secret: '',
      name: 'oauth',
      signup_access: false,
      url: 'http://mcp-a/mcp',
      oauth_scopes: null,
      oauth_resource: null,
      oauth_issuer: null,
    });
    assert.equal((await request('/admin/servers/oauth', 'PATCH', edit)).status, 200);
    const after = (await db.select().from(mcpServers)).find((server) => server.name === 'oauth')!;
    assert.equal(after.oauthClientSecret, before.oauthClientSecret, 'blank input retains the saved secret');
    assert.equal(after.authRevision, before.authRevision, 'unchanged optional fields must not invalidate credentials');
    assert.equal((await db.select().from(userMcpCredentials)).length, 1);
    assert.equal((await request('/admin/servers/oauth', 'PATCH', { ...edit, oauth_scopes: 'new-scope' })).status, 200);
    assert.equal(
      (await db.select().from(userMcpCredentials)).length,
      0,
      'real auth changes revoke existing connections',
    );
    assert.equal((await createServer('api-key', { auth_mode: 'api_key' })).status, 201);
    for (const api_key of ['', '   ', 'key\nvalue', 'x'.repeat(4097), 42])
      assert.deepEqual(await request('/me/servers/api-key/credential', 'PUT', { api_key }), {
        status: 400,
        data: { error: 'invalid_api_key' },
      });
    assert.equal((await request('/me/servers/api-key/credential', 'PUT', { api_key: 'valid-test-key' })).status, 200);
    console.log(
      'PASS: account validation, paused grants, duplicate instance rollback, OAuth secret retention, unchanged auth preservation, real auth revocation and API key validation',
    );
  } finally {
    await pool.end();
    await isolated.cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
