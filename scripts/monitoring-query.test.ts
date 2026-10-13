import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { Hono } = createRequire(new URL('../packages/auth-server/package.json', import.meta.url))(
  'hono',
) as typeof import('../packages/auth-server/node_modules/hono');
import { callLogQuery } from '../packages/auth-server/src/modules/monitoring/query.js';

async function query(search: string, userId?: number) {
  const app = new Hono();
  app.get('/', (c) => {
    try {
      return c.json(callLogQuery(c, userId));
    } catch {
      return c.json({ error: 'invalid' }, 400);
    }
  });
  return app.request('http://localhost/?' + search);
}
test('user scope is mandatory even when filters target another user or search content', async () => {
  const response = await query('user_id=99&q=private&outcome=success', 7);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.clauses.some((clause: string) => clause.includes('user_id=$2')));
  assert.ok(data.clauses.includes('user_id=$5'));
  assert.deepEqual(data.params.slice(1), [99, 'success', '%private%', 7]);
  assert.ok(data.clauses.some((clause: string) => clause.includes('(input ILIKE')));
});
test('administrator query supports all users and literal content search', async () => {
  const data = await (await query('q=100%25_')).json();
  assert.equal(data.params[1], '%100\\%\\_%');
  assert.ok(!data.clauses.some((clause: string) => clause.startsWith('user_id=')));
});
test('pagination retains identity constraint and rejects invalid cursors and filters', async () => {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const cursor = Buffer.from(JSON.stringify([123, id])).toString('base64url');
  const data = await (await query('cursor=' + cursor, 7)).json();
  assert.deepEqual(data.params.slice(1), [7, 123, id]);
  assert.ok(data.clauses.some((clause: string) => clause.includes('user_id=$2')));
  assert.ok(data.clauses.includes('(started_at,id)<($3,$4)'));
  for (const search of ['cursor=invalid', 'hours=2', 'outcome=invalid', 'user_id=-1', 'q=' + 'a'.repeat(257)])
    assert.equal((await query(search, 7)).status, 400);
});
