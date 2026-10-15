/** Real PostgreSQL/Lua, random keys, and a disposable schema; no external notification is delivered. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createIsolatedAuthSchema } from '@/scripts/isolated-auth-schema.js';
import { reserveUserRequest } from '@/gateway/routes/user-limits.js';
import { AggregateSessionStore } from '@/gateway/aggregate-session.js';
import type { McpServerConfig } from '@/shared/index.js';

const require = createRequire(new URL('../packages/auth-server/package.json', import.meta.url));
const { Hono } = require('hono'),
  { Redis } = require('ioredis');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function main() {
  for (const variable of ['DATABASE_URL', 'REDIS_URL']) {
    if (!process.env[variable] || !['127.0.0.1', 'localhost'].includes(new URL(process.env[variable]!).hostname))
      throw new Error('Set localhost DATABASE_URL and REDIS_URL for disposable integration fixtures');
  }
  const isolated = await createIsolatedAuthSchema();
  process.env.DATABASE_URL = isolated.databaseUrl;
  process.env.SYSTEM_CONFIG_MODE = 'file';
  process.env.NODE_ENV = 'test';
  process.env.CREDENTIAL_ENCRYPT_KEY = randomBytes(32).toString('hex');
  process.env.CREDENTIAL_BROKER_TOKEN = 'isolated-reliability-broker';
  process.env.INTERNAL_API_TOKEN = 'isolated-reliability-registry';
  const { db, pool } = await import('@/auth/infrastructure/database/client.js');
  const schema = await import('@/auth/infrastructure/database/schema.js');
  const { createLoginSession } = await import('@/auth/modules/identity/sessions.js');
  const { createConnectionsRouter } = await import('@/auth/modules/connections/router.js');
  const { createAdminRouter } = await import('@/auth/modules/admin/router.js');
  const { createRegistryRouter } = await import('@/auth/modules/upstreams/registry.js');
  const { credentialVersion } = await import('@/auth/infrastructure/security/credential-crypto.js');
  const { evaluateAlerts, deliverPendingAlerts } = await import('@/auth/modules/monitoring/alert-history.js');
  const { applySystemSettings } = await import('@/shared/index.js');
  const redis = new Redis(process.env.REDIS_URL),
    replica = new Redis(process.env.REDIS_URL);
  const tag = 'reliability-' + randomBytes(8).toString('hex');
  const cleanupPatterns: string[] = [],
    releases: Array<() => Promise<void>> = [];
  const originalFetch = globalThis.fetch;
  let probeBlocked = false,
    probeFailure = false,
    notifyFailure = true,
    notifications = 0;
  let entered = deferred(),
    release = deferred();
  const probeResult = () => ({
    ok: !probeFailure,
    reason: probeFailure ? 'auth_required' : 'ok',
    stage: 'initialize',
    duration_ms: 5,
    http_status: probeFailure ? 401 : 200,
    server: { name: 'fixture', version: '1' },
    protocol_version: '2025-03-26',
    tools_count: probeFailure ? null : 1,
  });
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/internal/upstream-test') {
      if (probeBlocked) {
        entered.resolve();
        await release.promise;
      }
      return Response.json(probeResult());
    }
    assert.equal(url.hostname, 'notifications.invalid', 'tests never contact another host');
    notifications++;
    return new Response(null, { status: notifyFailure ? 503 : 204 });
  }) as typeof fetch;
  try {
    const [user] = await db
      .insert(schema.users)
      .values({
        id: 10_000_000 + Math.floor(Math.random() * 10_000_000),
        username: 'person@example.test',
        passwordHash: 'unused',
        role: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning();
    const [admin] = await db
      .insert(schema.users)
      .values({
        username: 'admin@example.test',
        passwordHash: 'unused',
        role: 'admin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning();
    const cookie = `auth_session=${await createLoginSession(user.id, 0)}`;
    const adminCookie = `auth_session=${await createLoginSession(admin.id, 0)}`;
    const app = new Hono();
    app.route('/', createConnectionsRouter());
    app.route('/', createAdminRouter({ keys: {} as any, issuer: 'http://localhost' }));
    app.route('/', createRegistryRouter());
    const request = (path: string, method = 'GET', body?: unknown, auth = cookie) =>
      app.request(`http://localhost${path}`, {
        method,
        headers: { cookie: auth, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal(
      (
        await request(
          '/admin/servers',
          'POST',
          {
            name: tag,
            routing_mode: 'aggregate',
            auth_mode: 'none',
            monitoring_logs_enabled: false,
            user_rate_limit_per_minute: 30,
            user_daily_quota: 50,
            user_max_concurrent: 3,
          },
          adminCookie,
        )
      ).status,
      201,
    );
    const id = `${tag}-upstream`;
    assert.equal(
      (
        await request(
          `/admin/servers/${tag}/instances`,
          'POST',
          {
            id,
            url: 'http://upstream.invalid/mcp',
            auth_mode: 'api_key',
          },
          adminCookie,
        )
      ).status,
      201,
    );
    await db.insert(schema.userServerAccess).values({ userId: user.id, serverName: tag, createdAt: Date.now() });
    const save = async (key: string) => {
      const response = await request(`/me/upstreams/${id}/credential`, 'PUT', { api_key: key });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).connection_status, 'saved');
    };
    const status = async () =>
      (await (await request('/me/upstreams')).json()).servers.find((server: any) => server.name === id);
    await save('first-test-key');
    assert.equal((await status()).connection_status, 'saved');
    const tested = await request(`/me/upstreams/${id}/test-connection`, 'POST');
    assert.equal(tested.status, 200);
    assert.equal(JSON.stringify(await tested.json()).includes('first-test-key'), false);
    assert.equal((await status()).connection_status, 'connected');
    probeFailure = true;
    await request(`/me/upstreams/${id}/test-connection`, 'POST');
    assert.equal((await status()).connection_status, 'rejected');
    probeFailure = false;
    probeBlocked = true;
    const pending = request(`/me/upstreams/${id}/test-connection`, 'POST');
    await entered.promise;
    await save('replacement-test-key');
    release.resolve();
    assert.equal((await pending).status, 409, 'an old probe cannot verify a newly saved key');
    assert.equal((await status()).connection_status, 'saved');
    probeBlocked = false;
    const credential = (await pool.query('SELECT secret FROM upstream_credentials WHERE instance_id=$1', [id])).rows[0];
    const report = {
      instance_id: id,
      user_id: user.id,
      auth_version: 0,
      upstream_url: 'http://upstream.invalid/mcp',
      credential_version: credentialVersion(credential.secret),
      status: 'verified',
    };
    const validation = (body: unknown, token = process.env.CREDENTIAL_BROKER_TOKEN) =>
      app.request('http://localhost/internal/credential-validation', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await validation(report, 'incorrect')).status, 401);
    assert.equal((await (await validation({ ...report, auth_version: 1 })).json()).updated, false);
    assert.equal((await (await validation(report)).json()).updated, true);
    assert.equal((await status()).connection_status, 'connected');
    assert.equal(
      (await (await validation({ ...report, credential_version: 'f'.repeat(64), status: 'rejected' })).json()).updated,
      false,
    );
    const registry = await app.request('http://localhost/internal/mcp-servers', {
      headers: { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` },
    });
    assert.equal(registry.status, 200);
    const routes = await registry.json();
    assert.deepEqual(routes.servers[0].userLimits, { perMinute: 30, daily: 50, concurrent: 3 });
    assert.equal(routes.servers[0].monitoringLogsEnabled, false);
    assert.equal(
      (
        await app.request('http://localhost/internal/mcp-servers', {
          headers: {
            authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
            'if-none-match': registry.headers.get('etag')!,
          },
        })
      ).status,
      304,
    );
    assert.equal(
      (await request(`/admin/servers/${tag}`, 'PATCH', { monitoring_logs_enabled: true }, adminCookie)).status,
      200,
    );
    const changed = await app.request('http://localhost/internal/mcp-servers', {
      headers: {
        authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
        'if-none-match': registry.headers.get('etag')!,
      },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), registry.headers.get('etag'));
    console.log('PASS: credential validation, replacement races, authorization and versioned registry policy');

    const makeServer = (suffix: string, limits: NonNullable<McpServerConfig['userLimits']>): McpServerConfig => {
      const name = `${tag}-${suffix}`;
      const identity = createHash('sha256')
        .update(JSON.stringify([name, user.id]))
        .digest('hex');
      cleanupPatterns.push(`gw:limits:${identity}:*`);
      return { name, authMode: 'none', instances: [], userLimits: limits };
    };
    const concurrent = makeServer('concurrent', { perMinute: 0, daily: 0, concurrent: 3 });
    const permits = await Promise.all(
      Array.from({ length: 20 }, (_, index) => reserveUserRequest(index % 2 ? redis : replica, concurrent, user.id, 1)),
    );
    const accepted = permits.filter((permit) => 'release' in permit);
    assert.equal(accepted.length, 3, 'the limit is atomic across replicas');
    assert.ok(
      permits
        .filter((permit) => 'error' in permit)
        .every((permit) => permit.error === 'user_concurrency_limit_exceeded'),
    );
    for (const permit of accepted)
      if ('release' in permit) {
        releases.push(permit.release);
        await permit.release();
        await permit.release();
      }
    const minute = makeServer('minute', { perMinute: 1, daily: 0, concurrent: 0 });
    const first = await reserveUserRequest(redis, minute, user.id, 0);
    assert.ok('release' in first);
    const limited = await reserveUserRequest(replica, minute, user.id, 0);
    assert.ok('error' in limited && limited.error === 'user_rate_limit_exceeded' && limited.retryAfter > 0);
    const daily = makeServer('daily', { perMinute: 0, daily: 2, concurrent: 0 });
    for (let i = 0; i < 2; i++) assert.ok('release' in (await reserveUserRequest(redis, daily, user.id, 1)));
    assert.ok('error' in (await reserveUserRequest(replica, daily, user.id, 1)));
    assert.ok('release' in (await reserveUserRequest(redis, daily, user.id, 0)));
    const batch = makeServer('batch', { perMinute: 0, daily: 3, concurrent: 0 });
    assert.ok('release' in (await reserveUserRequest(redis, batch, user.id, 2)));
    assert.ok('error' in (await reserveUserRequest(replica, batch, user.id, 2)));
    assert.ok('release' in (await reserveUserRequest(redis, batch, user.id, 1)));
    const crashed = makeServer('crashed', { perMinute: 0, daily: 0, concurrent: 1 });
    const now = Date.now();
    const leaked = await reserveUserRequest(redis, crashed, user.id, 1, now);
    assert.ok('release' in leaked);
    if ('release' in leaked) releases.push(leaked.release);
    const recovered = await reserveUserRequest(replica, crashed, user.id, 1, now + 61_000);
    assert.ok('release' in recovered, 'a crashed process loses its expiring concurrency lease');
    if ('release' in recovered) releases.push(recovered.release);
    console.log('PASS: Redis limits across replicas, UTC daily tool quota and abandoned permit recovery');

    const key = `gw:aggregate:${tag}:${randomUUID()}`;
    cleanupPatterns.push(`${key}*`);
    await redis.set(key, JSON.stringify({ owner: user.id, authVersion: 0, members: {} }), 'EX', 30);
    const stores = [redis, replica].map((client) => new AggregateSessionStore(client, key, user.id, 0, 30));
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        stores[index % 2].update((session) => {
          session.members[`upstream-${index}`] = { revision: 0, protocolVersion: '2025-03-26', capabilities: {} };
        }),
      ),
    );
    assert.equal(Object.keys((await stores[0].read()).members).length, 20, 'CAS merges every concurrent state change');
    let initializes = 0;
    const initialize = async () => {
      initializes++;
      await new Promise((done) => setTimeout(done, 30));
      return { revision: 0, protocolVersion: '2025-03-26', capabilities: {} };
    };
    await Promise.all(stores.map((store) => store.member('same-upstream', 0, initialize)));
    assert.equal(initializes, 1, 'member initialization is shared across replicas');
    await redis.del(key);
    await assert.rejects(
      stores[0].update((session) => {
        session.toolRoutes = {};
      }),
      /session_not_found/,
    );
    assert.equal(await redis.get(key), null);
    console.log('PASS: real session CAS, shared member initialization and deletion without resurrection');

    applySystemSettings({
      public_url: 'http://localhost',
      upstream_allowlist_enabled: false,
      upstream_hosts: [],
      alert_webhook_url: 'http://notifications.invalid/hook',
    });
    const active = [{ server: tag, type: 'error_rate' as const, value: 80, threshold: 5 }];
    await evaluateAlerts(active);
    let alerts = (await pool.query('SELECT * FROM alert_events ORDER BY id')).rows;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].notification_attempts, 1);
    assert.ok(alerts[0].notification_error);
    await deliverPendingAlerts();
    assert.equal(notifications, 1, 'failure retry obeys backoff');
    await pool.query('UPDATE alert_events SET next_notification_at=0');
    notifyFailure = false;
    await Promise.all([deliverPendingAlerts(), deliverPendingAlerts()]);
    alerts = (await pool.query('SELECT * FROM alert_events ORDER BY id')).rows;
    assert.ok(alerts[0].notified_at);
    assert.equal(alerts[0].notification_attempts, 2);
    await evaluateAlerts([]);
    await evaluateAlerts(active);
    alerts = (await pool.query('SELECT * FROM alert_events ORDER BY id')).rows;
    assert.equal(alerts.length, 2, 'a recurring incident has its own history and notification');
    assert.ok(alerts[0].resolved_at && alerts[1].notified_at);
    assert.equal(alerts[1].acknowledged_at, null);
    assert.equal(notifications, 3);
    await evaluateAlerts([]);
    notifyFailure = true;
    await evaluateAlerts(active);
    for (let attempt = 0; attempt < 4; attempt++) {
      await pool.query('UPDATE alert_events SET next_notification_at=0 WHERE resolved_at IS NULL');
      await deliverPendingAlerts();
    }
    const exhausted = (await pool.query('SELECT * FROM alert_events WHERE resolved_at IS NULL')).rows[0];
    assert.equal(exhausted.notification_attempts, 5);
    const attempts = notifications;
    await pool.query('UPDATE alert_events SET next_notification_at=0 WHERE resolved_at IS NULL');
    await deliverPendingAlerts();
    assert.equal(notifications, attempts, 'a persistent delivery failure has a bounded retry budget');
    console.log('PASS: notification backoff, retry recovery and recurring incident history');
  } finally {
    release.resolve();
    globalThis.fetch = originalFetch;
    for (const done of releases) await done().catch(() => undefined);
    for (const pattern of cleanupPatterns) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    }
    redis.disconnect();
    replica.disconnect();
    await pool.end();
    await isolated.cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
