/** Verify live Gateway access after granting and revoking a user's service grant. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadPlatformConfig } from '@/shared/index.js';
import { getAccessToken } from '@/scripts/oauth-token.js';

const config = loadPlatformConfig();
const auth = process.env.AUTH_URL ?? config.auth.issuer;
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8000';
const origin = process.env.ADMIN_WEB_URL ?? 'http://localhost:5173';
const reportsUpstream = process.env.REPORTS_UPSTREAM_URL ?? 'http://localhost:3003';
if (!['localhost', '127.0.0.1'].includes(new URL(gateway).hostname)) throw new Error('Use a disposable local Gateway');

async function main() {
  let cookie = '';
  let userId: number | undefined;
  const serverName = `revoke-${randomUUID().slice(0, 8)}`;
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(new URL(path, auth), {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, data: await response.json().catch(() => ({})) };
  };

  try {
    const login = await request('/admin/session', 'POST', {
      username: process.env.MCP_USER ?? config.auth.bootstrap.adminUsername,
      password: process.env.MCP_PASSWORD ?? config.auth.bootstrap.adminPassword,
    });
    assert.equal(login.response.status, 200);
    cookie = login.response.headers.get('set-cookie')!.split(';')[0];

    const readyServer = await request('/admin/servers', 'POST', { name: `${serverName}-ready`, instances: [] });
    assert.equal(readyServer.response.status, 201);
    const password = `Revocation-${randomUUID()}`;
    const server = await request('/admin/servers', 'POST', {
      name: serverName,
      instances: [{ id: `${serverName}-a`, url: `${reportsUpstream}/mcp` }],
    });
    assert.equal(server.response.status, 201);
    const user = await request('/admin/users', 'POST', {
      username: `${serverName}@example.test`,
      password,
      role: 'user',
      servers: [serverName],
    });
    assert.equal(user.response.status, 201);
    userId = user.data.id;

    process.env.MCP_USER = `${serverName}@example.test`;
    process.env.MCP_PASSWORD = password;
    const token = (await getAccessToken()).access_token;
    const call = async () =>
      fetch(`${gateway}/mcp/${serverName}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'grant-revocation-smoke', version: '0.0.0' },
          },
        }),
      });
    assert.equal((await call()).status, 200, 'grant exposes a live upstream route');

    await request(`/admin/users/${userId}/servers`, 'PUT', { servers: [`${serverName}-ready`] });
    assert.equal((await call()).status, 403, 'stale JWT cannot access a newly granted server');
    await request(`/admin/users/${userId}/servers`, 'PUT', { servers: [] });
    assert.equal((await call()).status, 403, 'revocation is enforced by the live access check');

    console.log('PASS: grant revocation rejects an existing access token immediately');
  } finally {
    if (userId !== undefined) await request(`/admin/users/${userId}`, 'DELETE');
    for (const name of [serverName, `${serverName}-ready`]) await request(`/admin/servers/${name}`, 'DELETE');
    if (cookie) await request('/admin/session', 'DELETE');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
