import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'hono';
import { callLogQuery } from '../packages/auth-server/src/modules/monitoring/query.js';

function context(query: string) {
  const params = new URLSearchParams(query);
  return { req: { query: (key: string) => params.get(key) ?? undefined } } as unknown as Context;
}

test('custom call log range replaces rolling window and preserves user scope and cursor', () => {
  const cursor = Buffer.from(JSON.stringify([1500, '12345678-1234-1234-1234-123456789abc'])).toString('base64url');
  const result = callLogQuery(context(`start=1000&end=2000&server=example&cursor=${cursor}`), 42);
  assert.deepEqual(result.params, [1000, 'example', 42, 2000, 1500, '12345678-1234-1234-1234-123456789abc']);
  assert.ok(result.clauses.includes('started_at <= $4'));
  assert.ok(result.clauses.includes('user_id=$3'));
  assert.ok(result.clauses.includes('(started_at,id)<($5,$6)'));
});

test('call log range rejects incomplete, inverted and invalid timestamps', () => {
  for (const query of [
    'start=1000',
    'end=2000',
    'start=&end=2000',
    'start=3000&end=2000',
    'start=NaN&end=2000',
    'start=-1&end=2000',
  ]) {
    assert.throws(() => callLogQuery(context(query)), /invalid time range/);
  }
});

test('call logs retain the default rolling window without a custom range', () => {
  const now = Date.now();
  const result = callLogQuery(context(''));
  assert.ok(Number(result.params[0]) >= now - 86400000);
  assert.deepEqual(result.clauses, ['started_at >= $1']);
});
