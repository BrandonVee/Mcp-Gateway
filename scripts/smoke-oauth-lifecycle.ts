/** Real routes and PostgreSQL locks, with all fixtures confined to a disposable schema. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createIsolatedAuthSchema } from './isolated-auth-schema.js';

const require = createRequire(new URL('../packages/auth-server/package.json', import.meta.url));
const { Hono } = require('hono');
const { eq } = require('drizzle-orm');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

async function main() {
  const isolated = await createIsolatedAuthSchema();
  process.env.DATABASE_URL = isolated.databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.CREDENTIAL_ENCRYPT_KEY = '65'.repeat(32);
  process.env.CREDENTIAL_BROKER_TOKEN = 'isolated-oauth-broker';
  const { db, pool, createLoginSession } = await import('../packages/auth-server/src/db.js');
  const { mcpServers, oauthConnectionStates, userMcpCredentials, users } = await import('../packages/auth-server/src/schema.js');
  const { decryptCredential } = await import('../packages/auth-server/src/credential-crypto.js');
  const { createConnectionsRouter } = await import('../packages/auth-server/src/connections.js');
  const { createAdminRouter } = await import('../packages/auth-server/src/admin.js');
  const { scryptHash } = await import('../packages/auth-server/src/users.js');
  const { authIssuer } = await import('../packages/shared/src/index.js');
  type Mode = 'success' | 'short' | 'limited' | 'timeout' | 'network' | 'invalid' | 'blocked';
  let mode: Mode = 'success';
  let refreshCalls = 0;
  let tokenSequence = 0;
  let entered = deferred();
  let release = deferred();
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    if (params.get('grant_type') === 'refresh_token') refreshCalls++;
    const activeMode = mode;
    if (activeMode === 'blocked') { entered.resolve(); await release.promise; }
    if (activeMode === 'network') { response.destroy(); return; }
    response.setHeader('content-type', 'application/json');
    if (activeMode === 'limited' || activeMode === 'timeout' || activeMode === 'invalid') {
      response.statusCode = activeMode === 'limited' ? 429 : activeMode === 'timeout' ? 408 : 400;
      response.end(JSON.stringify({ error: activeMode === 'invalid' ? 'invalid_grant' : 'temporarily_unavailable' }));
      return;
    }
    const sequence = ++tokenSequence;
    response.end(JSON.stringify({ access_token: `access-${sequence}`, token_type: 'Bearer', expires_in: activeMode === 'short' ? 30 : 3600,
      ...(activeMode === 'short' ? {} : { refresh_token: `refresh-${sequence}` }) }));
  });
  try {
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const providerUrl = `http://127.0.0.1:${address.port}`;
    const now = Date.now();
    const password = 'isolated-oauth-test-password';
    const [user] = await db.insert(users).values({ username: `oauth-test-${randomBytes(8).toString('hex')}`, passwordHash: scryptHash(password), role: 'admin', createdAt: now, updatedAt: now }).returning();
    const cookie = `auth_session=${await createLoginSession(user.id, user.authVersion)}`;
    const app = new Hono();
    app.route('/', createConnectionsRouter());
    app.route('/', createAdminRouter({ keys: {} as any, issuer: authIssuer() }));
    const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost${path}`, {
      method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const name = 'oauth-lifecycle';
    const session = await request('/me/session');
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { authenticated: true, username: user.username, role: 'admin', user_id: user.id, auth_version: 0 });
    const signedIn = await request('/me/session', 'POST', { username: user.username, password });
    assert.equal(signedIn.status, 200);
    assert.deepEqual(await signedIn.json(), { authenticated: true, username: user.username, role: 'admin', user_id: user.id, auth_version: 0 }, 'login returns the same immutable identity as session validation');
    assert.equal((await request('/admin/servers', 'POST', {
      name, display_name: 'Isolated OAuth', instances: [], auth_mode: 'oauth',
      oauth_authorize_url: `${providerUrl}/authorize`, oauth_token_url: `${providerUrl}/token`, oauth_client_id: 'original-client', oauth_scopes: 'read',
    })).status, 201);
    const readCredential = async () => (await db.select().from(userMcpCredentials).where(eq(userMcpCredentials.userId, user.id)))[0];
    const readServer = async () => (await db.select().from(mcpServers).where(eq(mcpServers.name, name)))[0];
    const start = async () => {
      const response = await request(`/me/servers/${name}/oauth`, 'POST');
      assert.equal(response.status, 200);
      return new URL((await response.json()).authorization_url).searchParams.get('state')!;
    };
    const callback = (state: string) => request(`/oauth/callback/${name}?state=${state}&code=test-code`);
    const result = (response: Response) => new URL(response.headers.get('location')!).searchParams.get('result');
    const connect = async () => { assert.equal(result(await callback(await start())), 'connected'); };
    const broker = () => app.request(`http://localhost/internal/connector-credential?user_id=${user.id}&server=${name}&auth_version=0`, { headers: { authorization: `Bearer ${process.env.CREDENTIAL_BROKER_TOKEN}` } });
    const expire = () => db.update(userMcpCredentials).set({ expiresAt: Date.now() - 1 }).where(eq(userMcpCredentials.userId, user.id));
    const change = (fields: Record<string, unknown>) => request(`/admin/servers/${name}`, 'PATCH', { auth_mode: 'oauth', ...fields });
    const block = () => { mode = 'blocked'; entered = deferred(); release = deferred(); };

    mode = 'short';
    await connect();
    assert.equal((await broker()).status, 200, 'a 30-second token without refresh is usable');
    await expire();
    assert.equal((await broker()).status, 409, 'the token requires reconnection only after actual expiry');

    mode = 'success';
    await connect();
    await expire();
    const beforeRefresh = await readCredential();
    for (const failure of ['limited', 'timeout', 'network'] as const) {
      mode = failure;
      const response = await broker();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '5');
      assert.equal((await readCredential()).refreshSecret, beforeRefresh.refreshSecret, 'temporary failure preserves the rotating refresh token');
    }
    await db.update(userMcpCredentials).set({ expiresAt: Date.now() + 30_000 }).where(eq(userMcpCredentials.userId, user.id));
    mode = 'limited';
    assert.equal((await broker()).status, 200, 'still-valid access survives temporary refresh failure');
    await expire();
    mode = 'success';
    const callsBefore = refreshCalls;
    assert.deepEqual((await Promise.all([broker(), broker()])).map((response) => response.status), [200, 200]);
    assert.equal(refreshCalls - callsBefore, 1, 'concurrent refresh redeems the rotating token once');
    assert.notEqual(decryptCredential((await readCredential()).refreshSecret!), decryptCredential(beforeRefresh.refreshSecret!));
    await expire();
    mode = 'invalid';
    assert.equal((await broker()).status, 409);
    assert.equal((await readCredential()).refreshSecret, null, 'an explicit invalid_grant requires reconnection');

    block();
    const configState = await start();
    const configCallback = callback(configState);
    await entered.promise;
    const revision = (await readServer()).authRevision;
    assert.equal((await change({ oauth_scopes: 'write', oauth_client_id: 'replacement-client' })).status, 200);
    assert.equal((await change({ oauth_scopes: 'read', oauth_client_id: 'original-client' })).status, 200);
    assert.equal((await readServer()).authRevision, revision + 2, 'A-to-B-to-A still invalidates the old authorization');
    release.resolve();
    assert.equal(result(await configCallback), 'invalid_state');
    assert.equal(await readCredential(), undefined, 'old callback cannot recreate credentials after configuration edit');

    block();
    const revokedCallback = callback(await start());
    await entered.promise;
    assert.equal((await request(`/admin/connections/${user.id}/${name}`, 'DELETE')).status, 200, 'admin may revoke an in-flight connection without a saved credential');
    release.resolve();
    assert.equal(result(await revokedCallback), 'invalid_state');
    assert.equal(await readCredential(), undefined);

    block();
    const previousCallback = callback(await start());
    await entered.promise;
    const latestState = await start();
    release.resolve();
    assert.equal(result(await previousCallback), 'invalid_state', 'new authorization cancels the earlier in-flight callback');
    mode = 'success';
    assert.equal(result(await callback(latestState)), 'connected');

    await expire();
    block();
    const refreshing = broker();
    await entered.promise;
    const updating = change({ oauth_client_id: 'another-client' });
    release.resolve();
    assert.equal((await refreshing).status, 200);
    assert.equal((await updating).status, 200);
    assert.equal(await readCredential(), undefined, 'configuration edit removes credentials after an in-flight refresh completes');

    mode = 'success';
    await connect();
    await expire();
    block();
    const refreshToRevoke = broker();
    await entered.promise;
    const revoking = request(`/me/servers/${name}/credential`, 'DELETE');
    release.resolve();
    assert.equal((await refreshToRevoke).status, 200);
    assert.equal((await revoking).status, 200);
    assert.equal(await readCredential(), undefined, 'refresh cannot recreate a revoked connection');
    assert.equal((await db.select().from(oauthConnectionStates)).length, 0);

    // An old tab still displays the first account while a new tab has changed the shared cookie.
    const [other] = await db.insert(users).values({ username: `oauth-other-${randomBytes(8).toString('hex')}`, passwordHash: 'unused', role: 'user', allServers: true, createdAt: now, updatedAt: now }).returning();
    const otherCookie = `auth_session=${await createLoginSession(other.id, other.authVersion)}`;
    assert.equal((await request('/admin/servers', 'POST', { name: 'key-lifecycle', display_name: 'Isolated key', instances: [], auth_mode: 'api_key' })).status, 201);
    const switchedRequest = (path: string, method: string, identity: string, body?: unknown) => app.request(`http://localhost${path}`, {
      method, headers: { cookie: otherCookie, 'x-session-identity': identity, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const [path, method, body] of [
      ['/me/servers/key-lifecycle/credential', 'PUT', { api_key: 'old-tab-private-key' }],
      [`/me/servers/${name}/oauth`, 'POST', undefined],
      ['/me/session', 'DELETE', undefined],
    ] as const) {
      const stale = await switchedRequest(path, method, `${user.id}:0`, body);
      assert.equal(stale.status, 409, 'old tab cannot modify or log out the newly signed-in account');
      assert.deepEqual(await stale.json(), { error: 'session_changed' });
    }
    assert.equal((await db.select().from(userMcpCredentials).where(eq(userMcpCredentials.userId, other.id))).length, 0, 'stale key is not stored against the second account');
    const otherSession = await app.request('http://localhost/me/session', { headers: { cookie: otherCookie } });
    assert.equal(otherSession.status, 200, 'a stale logout did not revoke the new account session');
    assert.equal((await otherSession.json()).user_id, other.id);
    assert.equal((await switchedRequest('/me/servers/key-lifecycle/credential', 'PUT', `${other.id}:0`, { api_key: 'current-account-key' })).status, 200, 'matching identity permits the current account write');
    assert.equal((await switchedRequest('/me/servers/key-lifecycle/credential', 'DELETE', `${other.id}:0`)).status, 200);

    // Verify live JWT version checks on the credential broker without changing real users.
    await db.update(users).set({ authVersion: 1 }).where(eq(users.id, user.id));
    assert.equal((await broker()).status, 403, 'old token auth_version is rejected immediately');
    const expiredLogout = await app.request('http://localhost/me/session', { method: 'DELETE', headers: { cookie, 'x-session-identity': `${user.id}:0` } });
    assert.equal(expiredLogout.status, 200, 'expired sessions can still clear their cookie');
    assert.ok(expiredLogout.headers.get('set-cookie')?.includes('Max-Age=0'));
    console.log('PASS: isolated OAuth lifecycle covers short TTL, refresh recovery, callback/config/revoke races, live auth_version, immutable sessions and cross-tab identity protection');
  } finally {
    release.resolve();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await pool.end();
    await isolated.cleanup();
  }
}

// Imported Auth modules keep their Redis clients alive; all owned DB/HTTP resources are closed above.
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
