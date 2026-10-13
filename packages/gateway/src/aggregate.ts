import { mergeToolCatalog, type ToolRoute } from '@/gateway/tool-catalog.js';
import { upstreamRequestTimeout } from '@/gateway/transport-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@mcp/shared';

export type Upstream = NonNullable<McpServerConfig['upstreams']>[number];
type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, any> };
export type Header = { header: string; value: string } | null;
type Member = {
  sessionId?: string;
  protocolVersion: string;
  revision: number;
  capabilities: Record<string, any>;
  toolNames?: string[];
};
export type AggregateSession = {
  owner: number;
  authVersion: number;
  members: Record<string, Member>;
  toolRoutes?: Record<string, ToolRoute>;
};
export class AggregateError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
    readonly upstream?: string,
  ) {
    super(code);
  }
}
export const upstreamNamespace = (id: string) => 'mcp_' + createHash('sha256').update(id).digest('hex').slice(0, 16);
const nameFor = (u: Upstream, name: string) => `${upstreamNamespace(u.id)}__${name}`;
const uriFor = (u: Upstream, uri: string) => `mcp-gateway://${upstreamNamespace(u.id)}/${encodeURIComponent(uri)}`;

export interface AggregateDeps {
  credential(upstream: Upstream): Promise<{ credential: Header; revision: number }>;
  rpc(
    upstream: Upstream,
    message: Rpc,
    header: Header,
    member?: Member,
  ): Promise<{ result?: any; error?: any; sessionId?: string }>;
}

/** Concrete upstreams retain separate credentials, capabilities and MCP sessions. */
export class AggregateConnection {
  constructor(
    readonly upstreams: Upstream[],
    readonly session: AggregateSession,
    readonly deps: AggregateDeps,
  ) {}
  async prepare(u: Upstream) {
    const auth = await this.deps.credential(u);
    let member = this.session.members[u.id];
    if (!member || member.revision !== auth.revision) {
      const initialized = await this.deps.rpc(
        u,
        {
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mcp-gateway', version: '1.0.0' },
          },
        },
        auth.credential,
      );
      if (initialized.error || !initialized.result?.protocolVersion || !initialized.result?.capabilities)
        throw new AggregateError('upstream_initialize_failed', 502, u.id);
      member = {
        sessionId: initialized.sessionId,
        revision: auth.revision,
        protocolVersion: initialized.result.protocolVersion,
        capabilities: initialized.result.capabilities,
      };
      await this.deps.rpc(u, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth.credential, member);
      this.session.members[u.id] = member;
    }
    return { auth, member };
  }
  async invoke(u: Upstream, method: string, params?: Record<string, any>) {
    const { auth, member } = await this.prepare(u);
    return this.deps.rpc(u, { jsonrpc: '2.0', id: randomUUID(), method, params }, auth.credential, member);
  }
  async initialize() {
    const results = await Promise.allSettled(this.upstreams.map((u) => this.prepare(u)));
    const failures = results.flatMap((r, i) =>
      r.status === 'rejected'
        ? [
            {
              upstream_id: this.upstreams[i].id,
              error: r.reason instanceof AggregateError ? r.reason.code : 'upstream_unavailable',
            },
          ]
        : [],
    );
    if (results.every((r) => r.status === 'rejected')) {
      const reason = (results[0] as PromiseRejectedResult).reason;
      throw reason instanceof AggregateError ? reason : new AggregateError('upstream_unavailable', 502);
    }
    return {
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'mcp-gateway', version: '1.0.0' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      ...(failures.length ? { _meta: { unavailable_upstreams: failures } } : {}),
    };
  }
  async list(method: string, field: string) {
    const capability = field === 'tools' ? 'tools' : field === 'prompts' ? 'prompts' : 'resources';
    const results = await Promise.allSettled(
      this.upstreams.map(async (u) => {
        const { member } = await this.prepare(u);
        if (!member.capabilities[capability]) {
          if (field === 'tools') member.toolNames = [];
          return [];
        }
        const values: any[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 100; page++) {
          const response = await this.invoke(u, method, cursor ? { cursor } : {});
          if (response.error) throw new AggregateError('upstream_list_failed', 502, u.id);
          if (!Array.isArray(response.result?.[field]))
            throw new AggregateError('invalid_upstream_response', 502, u.id);
          if (
            field === 'tools' &&
            response.result[field].some((item: any) => !item || typeof item.name !== 'string' || !item.name)
          )
            throw new AggregateError('invalid_upstream_response', 502, u.id);
          values.push(
            ...response.result[field].map((item: any) => ({
              ...item,
              ...(typeof item.name === 'string' && field === 'prompts' ? { name: nameFor(u, item.name) } : {}),
              ...(typeof item.uri === 'string' ? { uri: uriFor(u, item.uri) } : {}),
              ...(typeof item.uriTemplate === 'string'
                ? { uriTemplate: uriFor(u, item.uriTemplate).replace(/%7B/gi, '{').replace(/%7D/gi, '}') }
                : {}),
            })),
          );
          cursor = response.result.nextCursor;
          if (!cursor) {
            if (field === 'tools') {
              const names = values.map((item) => item.name);
              if (new Set(names).size !== names.length) throw new AggregateError('duplicate_upstream_tool', 502, u.id);
              member.toolNames = names;
            }
            return values;
          }
          if (typeof cursor !== 'string' || seen.has(cursor))
            throw new AggregateError('invalid_upstream_cursor', 502, u.id);
          seen.add(cursor);
        }
        throw new AggregateError('upstream_catalog_too_large', 502, u.id);
      }),
    );
    if (results.every((r) => r.status === 'rejected')) throw new AggregateError('upstream_unavailable', 502);
    return {
      [field]:
        field === 'tools'
          ? mergeToolCatalog(
              this.upstreams,
              this.session,
              results.flatMap((result, index) =>
                result.status === 'fulfilled' ? [{ upstream: this.upstreams[index], tools: result.value }] : [],
              ),
            )
          : results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
      _meta: {
        unavailable_upstreams: results.flatMap((r, i) =>
          r.status === 'rejected'
            ? [
                {
                  upstream_id: this.upstreams[i].id,
                  error: r.reason instanceof AggregateError ? r.reason.code : 'upstream_unavailable',
                },
              ]
            : [],
        ),
      },
    };
  }
  async handle(message: Rpc) {
    if (message.method === 'ping') return { result: {} };
    if (message.method === 'notifications/initialized') return {};
    const listField = {
      'tools/list': 'tools',
      'prompts/list': 'prompts',
      'resources/list': 'resources',
      'resources/templates/list': 'resourceTemplates',
    }[message.method];
    if (listField) return { result: await this.list(message.method, listField) };
    const params = { ...message.params };
    let u: Upstream | undefined;
    if (message.method === 'tools/call') {
      if (typeof params.name !== 'string') return { error: { code: -32602, message: 'Unknown upstream tool' } };
      if (!this.session.toolRoutes) await this.list('tools/list', 'tools');
      const route = Object.hasOwn(this.session.toolRoutes!, params.name)
        ? this.session.toolRoutes![params.name]
        : undefined;
      if (route) {
        u = this.upstreams.find((upstream) => upstream.id === route.upstreamId);
        params.name = route.name;
      }
    } else if (message.method === 'prompts/get') {
      u = this.upstreams.find(
        (s) => typeof params.name === 'string' && params.name.startsWith(upstreamNamespace(s.id) + '__'),
      );
      if (u) params.name = params.name.slice(upstreamNamespace(u.id).length + 2);
    } else if (message.method === 'resources/read') {
      u = this.upstreams.find(
        (s) => typeof params.uri === 'string' && params.uri.startsWith(`mcp-gateway://${upstreamNamespace(s.id)}/`),
      );
      if (u) {
        try {
          params.uri = decodeURIComponent(params.uri.slice(`mcp-gateway://${upstreamNamespace(u.id)}/`.length));
        } catch {
          u = undefined;
        }
      }
    } else return { error: { code: -32601, message: 'Method not supported by this endpoint' } };
    if (!u) return { error: { code: -32602, message: 'Unknown upstream resource or name' } };
    const response = await this.invoke(u, message.method, params);
    if (message.method === 'resources/read' && Array.isArray(response.result?.contents))
      response.result.contents = response.result.contents.map((item: any) => ({
        ...item,
        ...(typeof item.uri === 'string' ? { uri: uriFor(u!, item.uri) } : {}),
      }));
    return response;
  }
}

/** JSON and SSE responses both terminate at the matching JSON-RPC response. */
export async function upstreamRpc(
  u: Upstream,
  message: Rpc,
  header: Header,
  member?: Member,
  fetchImpl: typeof fetch = fetch,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (header) headers[header.header] = header.value;
  if (member?.sessionId) headers['mcp-session-id'] = member.sessionId;
  if (member) headers['mcp-protocol-version'] = member.protocolVersion;
  const response = await fetchImpl(u.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    redirect: 'error',
    signal: AbortSignal.timeout(upstreamRequestTimeout(message.method, 30_000)),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const system = u.authMode === 'system_api_key' || u.authMode === 'system_oauth';
    throw new AggregateError(
      response.status === 401 || response.status === 403
        ? system
          ? 'system_credential_rejected'
          : 'upstream_credential_rejected'
        : 'upstream_unavailable',
      system ? 503 : 502,
      u.id,
    );
  }
  if (message.id === undefined) {
    await response.body?.cancel();
    return {};
  }
  const sessionId = response.headers.get('mcp-session-id') ?? undefined;
  const reader = response.body?.getReader();
  if (!reader) throw new AggregateError('invalid_upstream_response', 502, u.id);
  const decoder = new TextDecoder();
  let buffer = '',
    size = 0;
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new AggregateError('upstream_response_too_large', 502, u.id);
      buffer += decoder.decode(chunk.value, { stream: true });
      if (sse) {
        buffer = buffer.replace(/\r\n/g, '\n');
        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const rpc = JSON.parse(data);
          if (rpc.id === message.id) return { ...rpc, sessionId };
        }
      }
    }
    if (!sse) {
      const rpc = JSON.parse(buffer);
      if (rpc.id === message.id && (rpc.result !== undefined || rpc.error)) return { ...rpc, sessionId };
    }
    throw new AggregateError('invalid_upstream_response', 502, u.id);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
