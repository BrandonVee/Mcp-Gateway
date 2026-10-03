/** Verify persisted server edits against a running development Auth service. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadPlatformConfig } from '../packages/shared/src/index.js';

async function main() {
  const config = loadPlatformConfig();
  const base = process.env.AUTH_URL ?? config.auth.issuer;
  const origin = process.env.ADMIN_WEB_URL ?? 'http://localhost:5173';
  let name = `edit-test-${randomUUID()}`;
  let testUserId: number | undefined;
  let cookie = '';
  let created = false;

  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { response, data: await response.json() };
  }

  try {
    const login = await request('/admin/session', 'POST', {
      username: process.env.MCP_USER ?? config.auth.bootstrap.adminUsername,
      password: process.env.MCP_PASSWORD ?? config.auth.bootstrap.adminPassword,
    });
    assert.equal(login.response.status, 200, 'administrator login succeeds');
    cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    const list = await request('/admin/servers');
    assert.equal(list.response.status, 200, 'registry is readable after migration');
    const upstream = list.data.servers
      .flatMap((server: any) => server.instances)
      .find((instance: any) => instance.url)?.url;

    const registered = await request('/admin/servers', 'POST', {
      name,
      display_name: 'Editable service',
      description: ' Initial description ',
      instances: [],
      auth_mode: 'api_key',
    });
    created = registered.response.status === 201;
    assert.equal(registered.response.status, 201);
    assert.equal(registered.data.description, 'Initial description');
    const patch = (body: unknown) => request(`/admin/servers/${name}`, 'PATCH', body);
    const readServer = async () => {
      const result = await request('/admin/servers');
      assert.equal(result.response.status, 200);
      return result.data.servers.find((server: any) => server.name === name);
    };
    assert.equal(
      (await patch({ display_name: ' Updated service ', description: ' 第一行\n第二行 ' })).response.status,
      200,
    );
    let saved = await readServer();
    assert.equal(saved.display_name, 'Updated service');
    assert.equal(saved.description, '第一行\n第二行');
    const personal = await request('/me/servers');
    assert.equal(personal.response.status, 200);
    assert.equal(personal.data.servers.find((server: any) => server.name === name).description, saved.description);

    for (const body of [
      { description: null },
      { description: 123 },
      { description: 'x'.repeat(2001) },
      { display_name: '   ', description: 'Must not be saved' },
      { display_name: 'Must not be saved', description: [] },
    ])
      assert.equal((await patch(body)).response.status, 400, 'invalid info is rejected before saving');
    saved = await readServer();
    assert.equal(saved.display_name, 'Updated service');
    assert.equal(saved.description, '第一行\n第二行');
    assert.equal(
      (await request(`/me/servers/${name}/credential`, 'PUT', { api_key: `test-only-${randomUUID()}` })).response
        .status,
      200,
    );
    const testUser = await request('/admin/users', 'POST', {
      username: name,
      password: randomUUID(),
      role: 'user',
      servers: [name],
    });
    if (testUser.response.status === 201) testUserId = testUser.data.id;
    assert.equal(testUser.response.status, 201);
    assert.equal((await request(`/admin/users/${testUserId}`, 'PATCH', { disabled: true })).response.status, 200);
    assert.equal((await patch({ description: '', enabled: false })).response.status, 200);
    assert.equal((await readServer()).description, '', 'description can be cleared');

    if (upstream) {
      const instance = await request(`/admin/servers/${name}/instances`, 'POST', { url: upstream });
      assert.equal(instance.response.status, 201);
      const endpoint = `/admin/servers/${name}/instances/${instance.data.id}`;
      const changed = new URL(upstream);
      changed.searchParams.set('edit-test', name);
      assert.equal((await request(endpoint, 'PATCH', { url: changed.toString() })).response.status, 200);
      assert.equal((await readServer()).instances[0].url, changed.toString());
      assert.equal((await request(endpoint, 'PATCH', { url: 'file:///tmp/mcp' })).response.status, 400);
      assert.equal(
        (await readServer()).instances[0].url,
        changed.toString(),
        'invalid endpoint leaves the instance unchanged',
      );
    }
    const oldName = name;
    const nextName = `renamed-${randomUUID()}`;
    const beforeRename = await readServer();
    for (const invalidName of ['', '.', '..', 'bad/name', 'x'.repeat(65), null, 42]) {
      assert.equal((await patch({ name: invalidName, description: 'Must not be saved' })).response.status, 400);
    }
    const takenName = list.data.servers[0]?.name;
    if (takenName) {
      assert.equal((await patch({ name: takenName, display_name: 'Must not be saved' })).response.status, 409);
      assert.equal((await readServer()).display_name, beforeRename.display_name);
    }
    const renamed = await patch({ name: nextName, display_name: 'Renamed service', description: 'After rename' });
    if (renamed.response.status === 200) name = nextName;
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.data.name, nextName);
    const afterRename = await readServer();
    assert.equal(afterRename.display_name, 'Renamed service');
    assert.equal(afterRename.description, 'After rename');
    assert.deepEqual(afterRename.instances, beforeRename.instances, 'instance IDs and URLs survive rename');
    assert.equal((await request(`/admin/servers/${oldName}/users`)).response.status, 404, 'old ID is removed');
    assert.deepEqual(
      (await request(`/admin/servers/${nextName}/users`)).data.user_ids,
      [testUserId],
      'user grants survive rename',
    );
    const connections = (await request('/admin/connections')).data.connections;
    assert.ok(
      connections.some((connection: any) => connection.server_name === nextName),
      'saved credential survives rename',
    );
    assert.ok(!connections.some((connection: any) => connection.server_name === oldName));
    console.log(
      `PASS: transactional server renames retain grants, credentials, and instances; server name/description edits persist, personal portal receives descriptions, invalid edits are rejected${upstream ? ', instance URL edits persist' : ''}`,
    );
  } finally {
    if (testUserId !== undefined)
      assert.equal(
        (await request(`/admin/users/${testUserId}`, 'DELETE')).response.status,
        200,
        'temporary user removed',
      );
    if (created)
      assert.equal(
        (await request(`/admin/servers/${name}`, 'DELETE')).response.status,
        200,
        'temporary service removed',
      );
    if (cookie) assert.equal((await request('/admin/session', 'DELETE')).response.status, 200, 'test login revoked');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
