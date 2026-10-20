/** Use only a disposable, fixture-seeded local Auth/Gateway/PostgreSQL/Redis stack. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { getAccessToken } from '@/scripts/oauth-token.js';
const require = createRequire(new URL('../packages/auth-server/package.json', import.meta.url));
const { Redis } = require('ioredis'),
  { Pool } = require('pg');
const AUTH = process.env.AUTH_URL ?? 'http://localhost:9001',
  GW = process.env.GATEWAY_URL ?? 'http://localhost:8000';
for (const base of [AUTH, GW, process.env.DATABASE_URL ?? '', process.env.REDIS_URL ?? '']) {
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
    throw new Error('Use a disposable local test stack');
}
if (!process.env.ADMIN_PASSWORD) throw new Error('Set the disposable stack ADMIN_PASSWORD');
const name = 'monitor-' + randomBytes(4).toString('hex'),
  secret = 'DO-NOT-LOG-' + randomBytes(8).toString('hex');
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  redis = new Redis(process.env.REDIS_URL);
let cookie = '';
const admin = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(AUTH + '/admin' + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
};
const upstream = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (request.id === undefined) {
    res.writeHead(204);
    res.end();
    return;
  }
  const result = {
    jsonrpc: '2.0',
    id: request.id,
    result:
      request.method === 'initialize'
        ? {
            protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'monitoring-fixture', version: '1' },
          }
        : request.method === 'tools/list'
          ? { tools: [] }
          : {
              isError: request.params?.name === 'fail',
              content: [{ type: 'text', text: 'monitoring test output' }],
              api_key: secret,
            },
  };
  if (request.params?.name === 'unknown') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ unexpected: secret }));
    return;
  }
  if (request.params?.name === 'sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const wire = 'data: ' + JSON.stringify(result) + '\r\n\r\n';
    res.write(wire.slice(0, 17));
    res.end(wire.slice(17) + wire);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
});
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail('Timed out waiting for monitoring collection');
}
async function main() {
  await new Promise<void>((done) => upstream.listen(0, '0.0.0.0', done));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const original = (await pool.query("SELECT value FROM meta WHERE key='system_settings'")).rows[0]?.value;
  try {
    const login = await fetch(AUTH + '/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith('auth_session='))!
      .split(';')[0];
    assert.equal(
      (
        await admin('/servers', 'POST', {
          name,
          auth_mode: 'none',
          monitoring_logs_enabled: true,
          instances: [{ url: `http://${process.env.SIGNUP_UPSTREAM_HOST ?? '127.0.0.1'}:${address.port}/mcp` }],
        })
      ).response.status,
      201,
    );
    process.env.MCP_USER = 'admin';
    process.env.MCP_PASSWORD = process.env.ADMIN_PASSWORD;
    const token = (await getAccessToken()).access_token;
    const call = async (tool: string) => {
      const response = await fetch(GW + '/mcp/' + name, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: { password: secret } },
        }),
      });
      assert.equal(response.status, 200, await response.text());
    };
    await call('ok');
    await call('sse');
    await call('unknown');
    for (let i = 0; i < 20; i++) await call('fail');
    const summary = async () => (await admin('/monitoring/summary?server=' + name)).data;
    await waitFor(async () => (await summary()).summary.calls === 23);
    const data = await summary();
    assert.equal(data.enabled, true);
    assert.equal(data.logs_enabled, true);
    assert.equal(data.summary.success, 2);
    assert.equal(data.summary.failed, 20);
    assert.equal(data.summary.unknown, 1);
    assert.equal(data.summary.active_users, 1);
    assert.ok(data.summary.p95_ms > 0);
    assert.ok(data.alerts.some((alert: any) => alert.type === 'error_rate'));
    const logs = (await admin('/monitoring/calls?server=' + name)).data.events;
    assert.equal(logs.length, 23);
    assert.equal(JSON.stringify(logs).includes(secret), false);
    assert.ok(logs.every((event: any) => JSON.parse(event.input).arguments.password === '[REDACTED]'));
    assert.ok(
      logs
        .filter((event: any) => event.outcome !== 'unknown')
        .every((event: any) => JSON.parse(event.output).content[0].text === 'monitoring test output'),
    );
    assert.ok(
      logs
        .filter((event: any) => event.output)
        .every((event: any) => JSON.parse(event.output).api_key === '[REDACTED]'),
    );
    assert.equal((await admin('/monitoring/calls?server=' + name + '&outcome=failed')).data.events.length, 20);
    assert.deepEqual((await admin('/monitoring/tools?server=' + name + '&tool_search=ss')).data.tools, ['sse']);
    assert.equal(
      (await admin('/monitoring/calls?server=' + name + '&tool=s&tool_match=contains')).data.events.length,
      1,
    );
    assert.equal((await admin('/monitoring/calls?server=' + name + '&tool=s&tool_match=exact')).data.events.length, 0);
    const hourly = (await admin('/monitoring/summary?server=' + name + '&hours=1')).data;
    assert.ok(hourly.trend.length >= 60);
    assert.ok(hourly.trend.some((row: any) => row.calls === 0));
    assert.ok(logs.some((event: any) => event.error === 'tool_error' && event.http_status === 200));
    await redis.xadd(
      'mcp:monitoring:events',
      '*',
      'event',
      JSON.stringify({ ...logs[0], id: randomUUID(), method: 'http/GET', tool: '', duration_ms: null, detail: true }),
    );
    await waitFor(async () => (await summary()).collection.queued === 0);
    assert.equal((await summary()).summary.requests, 23, 'transport-only events from older gateways are ignored');
    assert.equal((await admin('/monitoring/calls?server=' + name)).data.events.length, 23);
    await redis.xadd(
      'mcp:monitoring:events',
      '*',
      'event',
      JSON.stringify({ ...logs[0], detail: true, arguments: { password: secret } }),
    );
    await waitFor(async () => (await summary()).collection.queued === 0);
    assert.equal((await summary()).summary.calls, 23, 'duplicate delivery must not double-count');
    for (const dimension of ['server', 'tool', 'user', 'client'])
      assert.equal(
        (await admin('/monitoring/summary?server=' + name + '&dimension=' + dimension)).response.status,
        200,
      );
    assert.equal((await admin('/monitoring/calls?cursor=invalid')).response.status, 400);
    assert.equal((await admin('/monitoring/summary?hours=999')).response.status, 400);
    assert.equal((await fetch(AUTH + '/admin/monitoring/summary')).status, 403);
    const settings = (await admin('/system-settings')).data;
    const save = async (options: unknown) => {
      const response = await admin('/system-settings', 'PUT', {
        ...settings,
        public_url: AUTH,
        upstream_allowlist_enabled: false,
        ...(options as object),
      });
      assert.equal(response.response.status, 200);
      // A missing route explicitly refreshes the control plane in legacy dev mode;
      // otherwise its first transition to database settings waits for the timer.
      assert.equal((await fetch(GW + '/mcp/refresh-' + name)).status, 404);
    };
    await save({ monitoring_logs_enabled: false });
    await call('ok');
    await waitFor(async () => (await summary()).summary.calls === 24);
    assert.equal((await summary()).logs_enabled, false, 'the log query can distinguish disabled details from no calls');
    assert.equal(
      (await admin('/monitoring/calls?server=' + name)).data.events.length,
      23,
      'details switch does not suppress aggregates',
    );
    await save({ monitoring_enabled: false });
    await call('ok');
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal((await summary()).summary.calls, 24, 'collection switch stops new events');
    assert.equal((await summary()).enabled, false);
    await save({ monitoring_enabled: true, monitoring_logs_enabled: true });
    for (let i = 0; i < 55; i++) await call('ok');
    await waitFor(async () => (await summary()).summary.calls === 79);
    const first = (await admin('/monitoring/calls?server=' + name)).data;
    assert.equal(first.events.length, 50);
    assert.ok(first.next_cursor);
    const next = (await admin('/monitoring/calls?server=' + name + '&cursor=' + encodeURIComponent(first.next_cursor)))
      .data;
    assert.ok(next.events.length >= 28);
    assert.equal(next.next_cursor, null);
    assert.equal(
      new Set([...first.events, ...next.events].map((event: any) => event.id)).size,
      first.events.length + next.events.length,
    );
    for (const method of ['initialize', 'tools/list']) {
      const response = await fetch(GW + '/mcp/' + name, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method }),
      });
      assert.equal(response.status, 200, await response.text());
    }
    await waitFor(async () => (await summary()).summary.requests === 81);
    assert.equal((await summary()).summary.calls, 79, 'protocol requests do not inflate tool call counts');
    const probe = await admin('/servers/test-connection', 'POST', {
      url: `http://${process.env.SIGNUP_UPSTREAM_HOST ?? '127.0.0.1'}:${address.port}/mcp`,
    });
    assert.equal(probe.response.status, 200);
    assert.equal(probe.data.ok, true);
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal((await summary()).summary.requests, 81, 'connection tests do not generate MCP call records');
    console.log(
      'PASS: JSON/SSE tool results, HTTP-200 errors, unknown outcomes, input/output capture and credential redaction, duplicate delivery, rankings, alerts, filters, cursor pagination, monitoring switches and exclusion of connection tests from call counts',
    );
  } finally {
    if (original === undefined) await pool.query("DELETE FROM meta WHERE key='system_settings'");
    else await pool.query("UPDATE meta SET value=$1 WHERE key='system_settings'", [original]);
    await admin('/servers/' + name, 'DELETE');
    await pool.end();
    await redis.quit();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
