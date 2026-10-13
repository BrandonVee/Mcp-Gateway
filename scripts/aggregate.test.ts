import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AggregateConnection,
  AggregateError,
  upstreamRpc,
  type Upstream,
  type AggregateSession,
} from '@/gateway/aggregate.js';
const upstreams: Upstream[] = [
  { id: 'search', url: 'http://search/mcp', authMode: 'system_api_key' },
  { id: 'papers', url: 'http://papers/mcp', authMode: 'api_key' },
];

function fixture(owner = 1) {
  const calls: Array<{ id: string; method: string; params: any; credential: any; session: string | undefined }> = [];
  const missing = new Set<string>();
  const session: AggregateSession = { owner, authVersion: 0, members: {} };
  const catalog: Record<string, string[]> = { search: ['search'], papers: ['search'] };
  const engine = new AggregateConnection(upstreams, session, {
    credential: async (u) => {
      if (missing.has(u.id)) throw new AggregateError('connection_required', 409, u.id);
      return {
        credential: { header: 'x-api-key', value: owner === 1 ? `${u.id}-key` : `${u.id}-key-${owner}` },
        revision: 0,
      };
    },
    rpc: async (u, message, credential, member) => {
      calls.push({ id: u.id, method: message.method, params: message.params, credential, session: member?.sessionId });
      if (message.method === 'initialize')
        return {
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} } },
          sessionId: `session-${u.id}`,
        };
      if (message.method === 'tools/list')
        return { result: { tools: catalog[u.id].map((name) => ({ name, inputSchema: { type: 'object' } })) } };
      if (message.method === 'resources/list')
        return { result: { resources: [{ uri: 'file:///same', name: 'same' }] } };
      if (message.method === 'prompts/list') return { result: { prompts: [{ name: 'summarize' }] } };
      if (message.method === 'resources/read')
        return { result: { contents: [{ uri: message.params?.uri, text: u.id }] } };
      return { result: { content: [{ type: 'text', text: u.id }] } };
    },
  });
  return { engine, session, calls, missing, catalog };
}

test('one endpoint adds readable server labels only to conflicting tools', async () => {
  const f = fixture();
  await f.engine.initialize();
  const tools = (await f.engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  assert.deepEqual(
    tools.map((t: any) => t.name),
    ['search__search', 'papers__search'],
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
      params: { name: 'papers__search' },
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

test('unique tools preserve their original names and route without an encoded MCP ID', async () => {
  const f = fixture();
  f.catalog.search = ['web_search'];
  f.catalog.papers = ['find_papers'];
  const listed = await f.engine.list('tools/list', 'tools');
  assert.deepEqual(
    listed.tools.map((tool: any) => tool.name),
    ['web_search', 'find_papers'],
  );
  const result = await f.engine.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'find_papers' },
  });
  assert.equal(result.result.content[0].text, 'papers');
  assert.equal(f.calls.at(-1)!.params.name, 'find_papers');
});

test('catalog aliases never steal a real tool name and survive Redis serialization', async () => {
  const f = fixture();
  f.catalog.search = ['search', 'papers__search'];
  const listed = await f.engine.list('tools/list', 'tools');
  assert.deepEqual(
    listed.tools.map((tool: any) => tool.name),
    ['search__search', 'papers__search', 'papers__search_2'],
  );
  const restored = JSON.parse(JSON.stringify(f.session));
  const restarted = new AggregateConnection(upstreams, restored, f.engine.deps);
  await restarted.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'papers__search_2' } });
  assert.equal(f.calls.at(-1)!.id, 'papers');
  assert.equal(f.calls.at(-1)!.params.name, 'search');
});

test('a failed credential never redirects a previously listed plain tool to another upstream', async () => {
  const f = fixture();
  f.missing.add('papers');
  assert.equal((await f.engine.list('tools/list', 'tools')).tools[0].name, 'search');
  f.missing.delete('papers');
  f.missing.add('search');
  const listed = await f.engine.list('tools/list', 'tools');
  assert.equal(listed.tools[0].name, 'papers__search');
  const before = f.calls.length;
  await assert.rejects(
    f.engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } }),
    /connection_required/,
  );
  assert.equal(f.calls.length, before);
});

test('users have separate tool routes, upstream sessions and credentials', async () => {
  const alice = fixture(1),
    bob = fixture(2);
  alice.missing.add('papers');
  assert.equal((await alice.engine.list('tools/list', 'tools')).tools.length, 1);
  assert.equal((await bob.engine.list('tools/list', 'tools')).tools.length, 2);
  await alice.engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } });
  await bob.engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search__search' } });
  assert.equal(alice.calls.at(-1)!.credential.value, 'search-key');
  assert.equal(bob.calls.at(-1)!.credential.value, 'search-key-2');
  assert.notDeepEqual(alice.session.toolRoutes, bob.session.toolRoutes);
});

test('readable collision aliases use Server display names and remain stable when registry order changes', async () => {
  const f = fixture();
  const named = upstreams.map((u) => ({ ...u, displayName: u.id === 'search' ? 'Web Search' : 'Paper Radar' }));
  const engine = new AggregateConnection(named, f.session, f.engine.deps);
  const list = await engine.list('tools/list', 'tools');
  assert.deepEqual(
    list.tools.map((tool: any) => tool.name),
    ['Web_Search__search', 'Paper_Radar__search'],
  );
  const reordered = new AggregateConnection([...named].reverse(), JSON.parse(JSON.stringify(f.session)), f.engine.deps);
  await reordered.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Paper_Radar__search' } });
  assert.equal(f.calls.at(-1)!.id, 'papers');
  assert.equal(f.calls.at(-1)!.params.name, 'search');
});

test('identical Server labels get distinct readable suffixes and catalog names cannot corrupt route storage', async () => {
  const f = fixture();
  f.catalog.search = ['search', '__proto__'];
  const named = upstreams.map((u) => ({ ...u, displayName: 'Tools' }));
  const engine = new AggregateConnection(named, f.session, f.engine.deps);
  const list = await engine.list('tools/list', 'tools');
  assert.equal(new Set(list.tools.map((tool: any) => tool.name)).size, 3);
  assert.ok(list.tools.some((tool: any) => tool.name === 'Tools__search'));
  assert.ok(list.tools.some((tool: any) => tool.name === 'Tools_2__search'));
  assert.ok(list.tools.some((tool: any) => tool.name === '__proto__'));
  const restored = new AggregateConnection(named, JSON.parse(JSON.stringify(f.session)), f.engine.deps);
  await restored.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '__proto__' } });
  assert.equal(f.calls.at(-1)!.id, 'search');
  assert.equal(f.calls.at(-1)!.params.name, '__proto__');
  const unknown = await restored.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'constructor' },
  });
  assert.equal(unknown.error.code, -32602);
});
