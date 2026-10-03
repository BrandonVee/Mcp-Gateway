/** Real PostgreSQL/router regressions in a disposable database; never modifies the configured application's database. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const require = createRequire(resolve('packages/auth-server/package.json'));
  const { Pool } = require('pg') as typeof import('../packages/auth-server/node_modules/pg');
  const { Hono } = require('hono') as typeof import('../packages/auth-server/node_modules/hono');
  const { SignJWT, decodeJwt } = require('jose') as typeof import('../packages/auth-server/node_modules/jose');
  if (!process.env.DATABASE_URL)
    throw new Error('Provide DATABASE_URL for a local PostgreSQL role with CREATE DATABASE permission');
  const originalUrl = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(originalUrl.hostname))
    throw new Error('Auth lifecycle smoke requires local disposable PostgreSQL');
  // Dropping the disposable database terminates its connections; an idle client
  // error must not surface as an unhandled event while the process shuts down.
  const quietIdleErrors = (pool: InstanceType<typeof Pool>) => {
    pool.on('error', () => undefined);
    return pool;
  };
  const databaseName = `mcp_auth_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const controlPool = quietIdleErrors(new Pool({ connectionString: originalUrl.toString() }));
  let fixturePool: InstanceType<typeof Pool> | undefined;
  let applicationPool: InstanceType<typeof Pool> | undefined;
  let created = false;

  try {
    await controlPool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const fixtureUrl = new URL(originalUrl);
    fixtureUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = fixtureUrl.toString();
    process.env.NODE_ENV = 'development';
    process.env.SYSTEM_CONFIG_MODE = 'file';
    process.env.ADMIN_USERNAME = 'custom-recovery-admin';
    process.env.ADMIN_PASSWORD = 'lifecycle-recovery-password-123456';
    process.env.INTERNAL_API_TOKEN = 'lifecycle-internal-token';
    delete process.env.ADMIN_BOOTSTRAP_RECOVERY;
    fixturePool = quietIdleErrors(new Pool({ connectionString: fixtureUrl.toString() }));
    const migrations = pathToFileURL(resolve('packages/auth-server/drizzle') + '/');
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrations), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    // Upgrade a genuine old schema with both valid and orphaned legacy credentials.
    for (const entry of journal.entries) {
      if (entry.tag === '0013_identity_lifecycle') {
        const now = Date.now();
        await fixturePool.query(
          "INSERT INTO users(username,password_hash,role,created_at,updated_at) VALUES ('migration-user','unused','user',$1,$1)",
          [now],
        );
        await fixturePool.query(
          "INSERT INTO login_sessions VALUES ('legacy-cookie','migration-user',$1),('orphan-cookie','deleted-user',$1)",
          [now + 3600000],
        );
        await fixturePool.query(
          "INSERT INTO refresh_tokens(token,client_id,sub,scope,expires_at,created_at) VALUES ('legacy-refresh','client','deleted-user','mcp',$1,$2)",
          [now + 3600000, now],
        );
        await fixturePool.query(
          "INSERT INTO auth_codes(code,client_id,redirect_uri,scope,code_challenge,sub,expires_at) VALUES ('legacy-code','client','http://localhost/callback','mcp','challenge','deleted-user',$1)",
          [now + 3600000],
        );
      }
      await fixturePool.query(readFileSync(new URL(`${entry.tag}.sql`, migrations), 'utf8'));
    }
    for (const table of ['login_sessions', 'refresh_tokens', 'auth_codes']) {
      assert.equal(
        (await fixturePool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
        0,
        'migration revokes legacy identities rather than guessing by username',
      );
    }
    assert.equal(
      (await fixturePool.query("SELECT count(*)::int AS n FROM users WHERE username='migration-user'")).rows[0].n,
      1,
      'migration preserves user accounts',
    );

    const database = await import('../packages/auth-server/src/db.js');
    applicationPool = database.pool;
    const { createAdminRouter } = await import('../packages/auth-server/src/admin.js');
    const { createConnectionsRouter } = await import('../packages/auth-server/src/connections.js');
    const { createTokenRouter } = await import('../packages/auth-server/src/token.js');
    const { createRegistryRouter } = await import('../packages/auth-server/src/registry.js');
    const stores = await import('../packages/auth-server/src/stores.js');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'http://localhost:9001';
    const keys = {
      kid: 'lifecycle-test',
      privateKey: pair.privateKey,
      publicJwk: pair.publicKey.export({ format: 'jwk' }),
    };
    const app = new Hono();
    app.route('/', createAdminRouter({ keys, issuer }));
    app.route('/', createConnectionsRouter());
    app.route('/', createTokenRouter({ keys, issuer, accessTokenTtlSeconds: 3600, defaultAudience: 'mcp-gateway' }));
    app.route('/', createRegistryRouter());
    const createUser = (username: string, role: 'admin' | 'user' = 'user') =>
      database.createUserRow(username, 'lifecycle-user-password-123456', role);
    const identity = async (id: number) => {
      const [user] = (await fixturePool!.query('SELECT id,username,auth_version FROM users WHERE id=$1', [id])).rows;
      return { userId: Number(user.id), sub: user.username as string, userAuthVersion: user.auth_version as number };
    };
    const session = async (id: number) => {
      const user = await identity(id);
      return 'auth_session=' + (await database.createLoginSession(id, user.userAuthVersion));
    };
    const request = async (
      path: string,
      options: { method?: string; cookie?: string; bearer?: string; identity?: string; body?: unknown } = {},
    ) => {
      const response = await app.request(path, {
        method: options.method ?? 'GET',
        headers: {
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...(options.identity === undefined ? {} : { 'x-session-identity': options.identity }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as any,
        cookie: response.headers.get('set-cookie')?.split(';')[0],
      };
    };
    const adminId = await createUser('custom-administrator', 'admin');
    const adminCookie = await session(adminId);
    const adminRequest = (path: string, method = 'GET', body?: unknown) =>
      request('/admin' + path, { method, cookie: adminCookie, body });
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const clientId = 'lifecycle-client';
    await fixturePool.query('INSERT INTO clients(client_id,redirect_uris,created_at) VALUES ($1,$2,$3)', [
      clientId,
      JSON.stringify(['http://localhost/callback']),
      Date.now(),
    ]);
    const authCode = async (id: number) =>
      stores.saveAuthCode({
        ...(await identity(id)),
        client_id: clientId,
        redirect_uri: 'http://localhost/callback',
        scope: 'mcp',
        code_challenge: challenge,
        expiresAt: Date.now() + 60000,
      });
    const refresh = async (id: number) =>
      stores.saveRefreshToken({ ...(await identity(id)), client_id: clientId, scope: 'mcp' });
    const exchangeCode = (code: string) =>
      request('/token', {
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          redirect_uri: 'http://localhost/callback',
          code_verifier: verifier,
        },
      });
    const exchangeRefresh = (refreshToken: string) =>
      request('/token', {
        method: 'POST',
        body: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
      });
    const signedAdminToken = async (id: number, overrides: Record<string, unknown> = {}) => {
      const user = await identity(id);
      return new SignJWT({
        uid: id,
        auth_version: user.userAuthVersion,
        role: 'admin',
        client_id: clientId,
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setSubject(user.sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(pair.privateKey);
    };

    // All state follows immutable IDs, including an already-issued admin JWT.
    const deletedId = await createUser('reused-username', 'admin');
    const oldCookie = await session(deletedId);
    const oldRefresh = await refresh(deletedId);
    const oldCode = await authCode(deletedId);
    const oldJwt = await signedAdminToken(deletedId);
    const capturedIdentity = await identity(deletedId);
    assert.equal((await adminRequest(`/users/${deletedId}`, 'DELETE')).status, 200);
    const replacementId = await createUser('reused-username', 'admin');
    assert.notEqual(replacementId, deletedId);
    assert.equal((await request('/me/session', { cookie: oldCookie })).status, 401);
    assert.equal((await request('/admin/session', { cookie: oldCookie })).status, 401);
    assert.equal((await request('/admin/session', { bearer: oldJwt })).status, 401);
    assert.equal((await exchangeRefresh(oldRefresh)).status, 400);
    assert.equal((await exchangeCode(oldCode)).status, 400);
    await assert.rejects(database.createLoginSession(deletedId, capturedIdentity.userAuthVersion));
    await assert.rejects(stores.saveRefreshToken({ ...capturedIdentity, client_id: clientId, scope: 'mcp' }));
    assert.equal((await request('/admin/session', { cookie: await session(replacementId) })).status, 200);
    // Both browser entry points share one cookie. Stale tabs must not act as the switched account.
    const replacementCookie = await session(replacementId);
    const replacementIdentity = `${replacementId}:0`;
    const staleIdentity = `${adminId}:0`;
    const migratedId = Number(
      (await fixturePool.query("SELECT id FROM users WHERE username='migration-user'")).rows[0].id,
    );
    const rejectedMutation = await request(`/admin/users/${migratedId}`, {
      method: 'PATCH',
      cookie: replacementCookie,
      identity: staleIdentity,
      body: { disabled: true },
    });
    assert.equal(rejectedMutation.status, 409);
    assert.equal(rejectedMutation.body.error, 'session_changed');
    assert.equal(
      (await fixturePool.query('SELECT disabled FROM users WHERE id=$1', [migratedId])).rows[0].disabled,
      false,
    );
    assert.equal(
      (await request('/admin/session', { method: 'DELETE', cookie: replacementCookie, identity: staleIdentity }))
        .status,
      409,
    );
    assert.equal(
      (await request('/admin/session', { cookie: replacementCookie })).status,
      200,
      'stale logout cannot terminate the switched account',
    );
    assert.equal(
      (
        await request(`/admin/users/${migratedId}`, {
          method: 'PATCH',
          cookie: replacementCookie,
          identity: replacementIdentity,
          body: { disabled: false },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/admin/users/${migratedId}`, {
          method: 'PATCH',
          bearer: await signedAdminToken(adminId),
          identity: 'unrelated-browser-identity',
          body: { disabled: false },
        })
      ).status,
      200,
      'explicit Bearer authentication remains independent of browser identity',
    );
    assert.equal(
      (await request('/admin/session', { method: 'DELETE', cookie: oldCookie, identity: `${deletedId}:0` })).status,
      200,
      'expired sessions can still clear their cookie',
    );
    const legacyLogin = await request('/admin/session', {
      method: 'POST',
      identity: 'stale-login-tab',
      body: { username: 'custom-administrator', password: 'lifecycle-user-password-123456' },
    });
    assert.equal(legacyLogin.status, 200, 'password login does not require a previous session identity');
    for (const body of [
      { username: 123, password: 'password' },
      { username: 'custom-administrator', password: {} },
    ]) {
      assert.equal(
        (await request('/admin/session', { method: 'POST', body })).status,
        401,
        'malformed legacy login credentials cannot crash the handler',
      );
    }
    // The unified browser login preserves administrator audits without auditing ordinary portal activity.
    const auditPassword = 'must-not-be-in-audit-password';
    assert.equal(
      (
        await request('/me/session?password=must-not-be-in-audit-query', {
          method: 'POST',
          body: { username: 'custom-administrator', password: auditPassword },
        })
      ).status,
      401,
    );
    const unifiedLogin = await request('/me/session', {
      method: 'POST',
      body: { username: 'custom-administrator', password: 'lifecycle-user-password-123456' },
    });
    assert.equal(unifiedLogin.status, 200);
    assert.equal(unifiedLogin.body.user_id, adminId);
    assert.equal(
      (await request('/admin/session', { cookie: unifiedLogin.cookie })).status,
      200,
      'unified administrator login shares the existing admin cookie',
    );
    assert.equal(
      (await request('/me/session', { method: 'DELETE', cookie: unifiedLogin.cookie, identity: `${adminId}:0` }))
        .status,
      200,
    );
    const auditRows = (await fixturePool.query("SELECT * FROM audit_events WHERE path='/me/session' ORDER BY id")).rows;
    assert.deepEqual(
      auditRows.map((row) => [row.actor, row.method, row.status_code]),
      [
        ['custom-administrator', 'POST', 401],
        ['custom-administrator', 'POST', 200],
        ['custom-administrator', 'DELETE', 200],
      ],
    );
    for (const row of auditRows)
      assert.deepEqual(Object.keys(row).sort(), [
        'actor',
        'created_at',
        'id',
        'method',
        'path',
        'request_id',
        'status_code',
      ]);
    const auditJson = JSON.stringify(auditRows);
    for (const secret of [
      auditPassword,
      'must-not-be-in-audit-query',
      'lifecycle-user-password-123456',
      unifiedLogin.cookie!,
    ]) {
      assert.equal(auditJson.includes(secret), false, 'audit records contain metadata only');
    }
    await createUser('audit-ordinary-user');
    const ordinaryLogin = await request('/me/session', {
      method: 'POST',
      body: { username: 'audit-ordinary-user', password: 'lifecycle-user-password-123456' },
    });
    assert.equal(ordinaryLogin.status, 200);
    assert.equal(
      (
        await request('/me/session', {
          method: 'POST',
          body: { username: 'audit-ordinary-user', password: auditPassword },
        })
      ).status,
      401,
    );
    assert.equal((await request('/me/session', { method: 'DELETE', cookie: ordinaryLogin.cookie })).status, 200);
    assert.equal(
      (await fixturePool.query("SELECT count(*)::int AS n FROM audit_events WHERE path='/me/session'")).rows[0].n,
      3,
    );
    assert.equal((await adminRequest(`/users/${replacementId}`, 'DELETE')).status, 200);

    // Last administrator protection uses role/status, including custom names and concurrent requests.
    let dto = (await adminRequest('/users')).body.users.find((user: any) => user.id === adminId);
    assert.equal(dto.can_disable, false);
    assert.equal(dto.can_delete, false);
    const legacyAdminJwt = await signedAdminToken(adminId, { auth_version: undefined });
    assert.equal(
      (await request('/admin/session', { bearer: legacyAdminJwt })).status,
      200,
      'pre-upgrade JWTs with matching ID retain version-zero compatibility',
    );
    assert.equal(
      (await request('/admin/session', { bearer: await signedAdminToken(adminId, { uid: replacementId }) })).status,
      401,
      'username cannot substitute for JWT user ID',
    );
    for (const body of [{ disabled: true }, { role: 'user' }])
      assert.equal((await adminRequest(`/users/${adminId}`, 'PATCH', body)).status, 409);
    assert.equal((await adminRequest(`/users/${adminId}`, 'DELETE')).status, 409);
    const secondId = await createUser('second-administrator', 'admin');
    const secondCookie = await session(secondId);
    const race = await Promise.all([
      adminRequest(`/users/${adminId}`, 'PATCH', { disabled: true }),
      request(`/admin/users/${secondId}`, { method: 'DELETE', cookie: secondCookie }),
    ]);
    assert.deepEqual(
      race.map((result) => result.status).sort(),
      [200, 409],
      'concurrent lifecycle changes preserve exactly one active administrator',
    );
    assert.equal(
      (await fixturePool.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND disabled=false")).rows[0].n,
      1,
    );
    // Restore deterministic fixture ownership without weakening the tested API guard.
    await fixturePool.query("UPDATE users SET disabled=false,role='admin' WHERE id=$1", [adminId]);
    await fixturePool.query('DELETE FROM users WHERE id=$1', [secondId]);
    const freshAdminCookie = await session(adminId);
    const mutate = (path: string, body: unknown) =>
      request('/admin' + path, { method: 'PATCH', cookie: freshAdminCookie, body });

    // A credential verified before a reset/disable cannot finish issuance afterwards.
    const targetId = await createUser('reset-target');
    await fixturePool.query(
      "INSERT INTO mcp_servers(name,display_name,created_at,updated_at) VALUES ('lifecycle-service','Lifecycle',$1,$1)",
      [Date.now()],
    );
    const liveAccess = (version?: number) =>
      request(
        `/internal/mcp-access?user_id=${targetId}&server=lifecycle-service${version === undefined ? '' : '&auth_version=' + version}`,
        { bearer: process.env.INTERNAL_API_TOKEN },
      );
    await fixturePool.query('UPDATE users SET all_servers=true WHERE id=$1', [targetId]);
    assert.equal((await liveAccess()).status, 200, 'old JWT version defaults to zero before identity changes');
    const beforeReset = await identity(targetId);
    const resetCookie = await session(targetId);
    const resetRefresh = await refresh(targetId);
    const resetCode = await authCode(targetId);
    assert.equal((await mutate(`/users/${targetId}`, { password: 'new-lifecycle-password-123456' })).status, 200);
    assert.equal((await request('/me/session', { cookie: resetCookie })).status, 401);
    assert.equal((await exchangeRefresh(resetRefresh)).status, 400);
    assert.equal((await exchangeCode(resetCode)).status, 400);
    assert.equal((await liveAccess()).status, 403, 'password reset rejects pre-upgrade JWTs immediately');
    assert.equal((await liveAccess(1)).status, 200, 'new authentication version retains assigned service access');
    await assert.rejects(database.createLoginSession(targetId, beforeReset.userAuthVersion));
    await assert.rejects(
      stores.saveAuthCode({
        ...beforeReset,
        client_id: clientId,
        redirect_uri: 'http://localhost/callback',
        scope: 'mcp',
        code_challenge: challenge,
        expiresAt: Date.now() + 60000,
      }),
    );
    const resetTokens = await exchangeCode(await authCode(targetId));
    assert.equal(resetTokens.status, 200);
    const claims = decodeJwt(resetTokens.body.access_token);
    assert.equal(claims.uid, targetId);
    assert.equal(claims.auth_version, 1);
    const doubleRefresh = await Promise.all([
      exchangeRefresh(resetTokens.body.refresh_token),
      exchangeRefresh(resetTokens.body.refresh_token),
    ]);
    assert.deepEqual(
      doubleRefresh.map((result) => result.status).sort(),
      [200, 400],
      'one-time refresh rotation remains atomic',
    );
    assert.equal((await mutate(`/users/${targetId}`, { disabled: true })).status, 200);
    assert.equal((await mutate(`/users/${targetId}`, { disabled: false })).status, 200);
    await assert.rejects(
      database.createLoginSession(targetId, 1),
      're-enabling cannot revive credentials captured before disable',
    );

    // Reset waits for an in-flight issuer, then revokes that issuer's committed credentials.
    const lockedId = await createUser('locked-issuer');
    const lockedIdentity = await identity(lockedId);
    let releaseIssuer!: () => void;
    let issuerLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      issuerLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseIssuer = resolve;
    });
    const pendingIssue = database.withAuthenticatedUser(lockedIdentity, async (tx) => {
      issuerLocked();
      await release;
      return stores.saveRefreshToken({ ...lockedIdentity, client_id: clientId, scope: 'mcp' }, tx);
    });
    await locked;
    const pendingReset = mutate(`/users/${lockedId}`, { password: 'locked-new-password-123456' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseIssuer();
    const issuedWhileReset = await pendingIssue;
    assert.equal((await pendingReset).status, 200);
    assert.equal((await exchangeRefresh(issuedWhileReset)).status, 400);
    const beforeAdminReset = await signedAdminToken(adminId);
    assert.equal((await mutate(`/users/${adminId}`, { password: 'new-administrator-password-123456' })).status, 200);
    assert.equal(
      (await request('/admin/session', { bearer: beforeAdminReset })).status,
      401,
      'administrator password reset invalidates bearer access immediately',
    );

    // A legacy lockout never automatically re-enables an explicitly disabled user.
    await fixturePool.query("UPDATE users SET disabled=true WHERE role='admin'");
    await createUser(process.env.ADMIN_USERNAME, 'user');
    await assert.rejects(database.bootstrapAdmin(), /ADMIN_BOOTSTRAP_RECOVERY/);
    assert.equal(
      (await fixturePool.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND disabled=false")).rows[0].n,
      0,
    );
    process.env.ADMIN_BOOTSTRAP_RECOVERY = 'true';
    await database.bootstrapAdmin();
    const recovered = await database.verifyUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
    assert.equal(recovered?.role, 'admin');
    assert.equal(
      (await fixturePool.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND disabled=false")).rows[0].n,
      1,
    );
    delete process.env.ADMIN_BOOTSTRAP_RECOVERY;
    await database.bootstrapAdmin();
    assert.equal(
      (await identity(recovered!.id)).userAuthVersion,
      1,
      'normal restarts preserve existing administrators',
    );
    console.log(
      'PASS: migration revokes unsafe legacy identities; deleted username reuse, cross-tab identity protection, JWT identity, reset/disable issuance races, concurrent last-admin protection, refresh rotation and explicit administrator recovery',
    );
  } finally {
    await applicationPool?.end();
    await fixturePool?.end();
    if (created) await controlPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await controlPool.end();
  }
  // Imported routers use a shared Redis connection; the disposable script owns this process.
  process.exit(0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
