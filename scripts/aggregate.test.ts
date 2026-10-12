import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AggregateConnection,
  AggregateError,
  upstreamNamespace,
  upstreamRpc,
  type Upstream,
} from '../packages/gateway/src/aggregate.js';
const upstreams: Upstream[] = [
  { id: 'search', url: 'http://search/mcp', authMode: 'system_api_key' },
  { id: 'papers', url: 'http://papers/mcp', authMode: 'api_key' },
];

function fixture() {
  const calls: Array<{ id: string; method: string; params: any; credential: any; session: string | undefined }> = [];
  const missing = new Set<string>();
  const session = { owner: 1, authVersion: 0, members: {} };
  const engine = new AggregateConnection(upstreams, session, {
    credential: async (u) => {
      if (missing.has(u.id)) throw new AggregateError('connection_required', 409, u.id);
      return { credential: { header: 'x-api-key', value: `${u.id}-key` }, revision: 0 };
    },
    rpc: async (u, message, credential, member) => {
      calls.push({ id: u.id, method: message.method, params: message.params, credential, session: member?.sessionId });
      if (message.method === 'initialize')
        return {
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} } },
          sessionId: `session-${u.id}`,
        };
      if (message.method === 'tools/list')
        return { result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } };
      if (message.method === 'resources/list')
        return { result: { resources: [{ uri: 'file:///same', name: 'same' }] } };
      if (message.method === 'prompts/list') return { result: { prompts: [{ name: 'summarize' }] } };
      if (message.method === 'resources/read')
        return { result: { contents: [{ uri: message.params?.uri, text: u.id }] } };
      return { result: { content: [{ type: 'text', text: u.id }] } };
    },
  });
  return { engine, session, calls, missing };
}

test('one endpoint aggregates independent upstreams and namespaces conflicting names', async () => {
  const f = fixture();
  await f.engine.initialize();
  const tools = (await f.engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  assert.deepEqual(
    tools.map((t: any) => t.name),
    upstreams.map((u) => `${upstreamNamespace(u.id)}__search`),
  );
  const result = await f.engine.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: tools[1].name, arguments: { query: 'test' } },
  });
  assert.equal(result.result.content[0].text, 'papers');
  const call = f.calls.at(-1)!;
  assert.equal(call.id, 'papers');
  assert.equal(call.credential.value, 'papers-key');
  assert.equal(call.session, 'session-papers');
  assert.equal(call.params.name, 'search');
  assert.equal(f.calls.filter((c) => c.method === 'initialize').length, 2, 'upstream sessions survive subsequent RPCs');
  const unknown = await f.engine.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'other__search' },
  });
  assert.equal(unknown.error.code, -32602);
});

test('credentials are rechecked for every invocation and a missing user connection only hides that upstream', async () => {
  const f = fixture();
  f.missing.add('papers');
  const initialized = await f.engine.initialize();
  assert.equal(initialized._meta!.unavailable_upstreams[0].upstream_id, 'papers');
  const list = (await f.engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result;
  assert.equal(list.tools.length, 1);
  assert.equal(list._meta.unavailable_upstreams[0].error, 'connection_required');
  f.missing.delete('papers');
  assert.equal((await f.engine.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 2);
  f.missing.add('papers');
  const before = f.calls.length;
  await assert.rejects(
    f.engine.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: `${upstreamNamespace('papers')}__search` },
    }),
    /connection_required/,
  );
  assert.equal(f.calls.length, before, 'revoked credentials do not reach upstream');
});

test('resources and prompts retain their upstream identity', async () => {
  const f = fixture();
  const resources = (await f.engine.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).result.resources;
  assert.notEqual(resources[0].uri, resources[1].uri);
  const read = await f.engine.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'resources/read',
    params: { uri: resources[1].uri },
  });
  assert.equal(f.calls.at(-1)!.params.uri, 'file:///same');
  assert.equal(read.result.contents[0].uri, resources[1].uri);
  const prompts = (await f.engine.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/list' })).result.prompts;
  await f.engine.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: prompts[0].name } });
  assert.equal(f.calls.at(-1)!.id, 'search');
  assert.equal(f.calls.at(-1)!.params.name, 'summarize');
});

test('JSON and SSE upstream responses use their own credential and never follow redirects', async () => {
  const rpc = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
  for (const sse of [false, true]) {
    const response = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
    const result = await upstreamRpc(
      upstreams[0],
      rpc,
      { header: 'x-api-key', value: 'secret' },
      { sessionId: 'session-search', protocolVersion: '2025-03-26', revision: 0, capabilities: {} },
      async (_url, init) => {
        assert.equal(init!.redirect, 'error');
        const headers = new Headers(init!.headers);
        assert.equal(headers.get('x-api-key'), 'secret');
        assert.equal(headers.get('mcp-session-id'), 'session-search');
        return new Response(
          sse ? `event: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n` : JSON.stringify(response),
          { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } },
        );
      },
    );
    assert.deepEqual(result.result, { tools: [] });
  }
  await assert.rejects(
    upstreamRpc(upstreams[0], rpc, null, undefined, async () => new Response('{}', { status: 401 })),
    /system_credential_rejected/,
  );
});
