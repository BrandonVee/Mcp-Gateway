import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  latencyHistogram,
  histogramP95,
  validCallEvent,
  normalizeSystemSettings,
} from '../packages/shared/src/index.js';
import { alertFingerprint } from '../packages/shared/src/alerts.js';
import { ResponseObserver, requestMetadata } from '../packages/gateway/src/response-observer.js';

test('monitoring extracts only RPC metadata and never retains tool arguments', () => {
  const input = {
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/call',
    params: { name: 'lookup', arguments: { token: 'secret' } },
  };
  assert.deepEqual(requestMetadata(Buffer.from(JSON.stringify(input)), 'POST'), [
    { id: 42, method: 'tools/call', tool: 'lookup' },
  ]);
  assert.deepEqual(requestMetadata(Buffer.from('invalid'), 'POST'), [{ id: null, method: 'http/POST', tool: '' }]);
});
test('JSON and chunked SSE observe actual RPC and tool errors, including UTF-8 split boundaries', () => {
  for (const contentType of ['application/json', 'text/event-stream']) {
    const seen: unknown[] = [];
    const observer = new ResponseObserver(contentType, (...args) => seen.push(args));
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 'a', result: { isError: true, content: [{ text: '秘密' }] } },
      { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'secret' } },
    ]);
    const wire = Buffer.from(contentType.includes('stream') ? 'event: message\r\ndata: ' + body + '\r\n\r\n' : body);
    for (const byte of wire) observer.write(Buffer.from([byte]));
    observer.end();
    assert.deepEqual(seen, [
      ['a', true, 'tool_error'],
      [2, true, 'json_rpc_error'],
    ]);
  }
});
test('oversized SSE events are ignored and subsequent bounded events still work', () => {
  const seen: unknown[] = [];
  const observer = new ResponseObserver('text/event-stream', (...args) => seen.push(args), 64);
  observer.write(Buffer.from('data: ' + 'x'.repeat(10000) + '\n\n'));
  observer.write(Buffer.from('data: {"id":9,"result":{}}\n\n'));
  observer.end();
  assert.deepEqual(seen, [[9, false, '']]);
  const json = new ResponseObserver('application/json', () => assert.fail('oversized JSON must stay unknown'), 10);
  json.write(Buffer.from('{"id":9,"result":{}}'));
  json.end();
});
test('merged latency distributions preserve percentile weighting and unknown durations', () => {
  const merged = latencyHistogram(null);
  for (const duration of [...Array(19).fill(10), 9000]) latencyHistogram(duration).forEach((n, i) => (merged[i] += n));
  assert.equal(histogramP95(merged), 25);
  assert.equal(histogramP95(latencyHistogram(null)), null);
  assert.equal(histogramP95(latencyHistogram(9000)), 10000);
});
test('collection envelopes project safe fields, reject invalid values, and validate settings', () => {
  const event = {
    id: randomUUID(),
    request_id: randomUUID(),
    started_at: Date.now() - 5,
    finished_at: Date.now(),
    user_id: 1,
    username: 'alice',
    client_id: 'c',
    server: 's',
    method: 'tools/call',
    tool: 'lookup',
    outcome: 'success',
    http_status: 200,
    duration_ms: 5,
    error: '',
    instance: 'i',
    attempts: 1,
    detail: true,
  };
  assert.deepEqual(validCallEvent({ ...event, arguments: { token: 'secret' }, response: 'secret' }), event);
  assert.equal(validCallEvent({ ...event, outcome: 'pending' }), null);
  assert.equal(validCallEvent({ ...event, started_at: 0 }), null);
  assert.equal(validCallEvent({ ...event, detail: 'true' }), null);
  const base = { public_url: 'https://mcp.example.test', upstream_hosts: [] };
  assert.equal(normalizeSystemSettings({ ...base, registration_enabled: false })?.registration_enabled, false);
  assert.equal(normalizeSystemSettings({ ...base, registration_enabled: 'false' }), null);
  assert.equal(normalizeSystemSettings({ ...base, monitoring_retention_days: 0 }), null);
  assert.equal(normalizeSystemSettings({ ...base, monitoring_slow_ms: 1.5 }), null);
});
test('alert settings and fingerprints follow normalized validation rules', () => {
  const base = { public_url: 'https://mcp.example.test', upstream_hosts: [] };
  const settings = normalizeSystemSettings({
    ...base,
    alert_email_recipients: ['ops@example.test'],
    alert_webhook_url: 'https://hooks.example.test/alert',
  });
  assert.deepEqual(settings?.alert_email_recipients, ['ops@example.test']);
  assert.equal(settings?.alert_webhook_url, 'https://hooks.example.test/alert');
  assert.equal(normalizeSystemSettings({ ...base, alert_webhook_url: 'ftp://bad' }), null);
  assert.equal(alertFingerprint('a', 'slow_calls'), 'a\x1fslow_calls');
});
