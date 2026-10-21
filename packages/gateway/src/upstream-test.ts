import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamTestResult, UpstreamTestCredential } from '@mcp/shared';

class ProbeError extends Error {
  constructor(
    readonly reason: UpstreamTestResult['reason'],
    readonly httpStatus?: number,
  ) {
    super(reason);
  }
}

/** Classify transport errors without returning upstream bodies, headers or credentials. */
export function upstreamTestFailure(error: unknown): UpstreamTestResult['reason'] {
  if (error instanceof ProbeError) return error.reason;
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const failure = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(String(failure.code))) return 'dns';
    if (failure.code === 'ECONNREFUSED') return 'connection_refused';
    if (
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', '-32001'].includes(String(failure.code)) ||
      ['AbortError', 'TimeoutError'].includes(String(failure.name))
    )
      return 'timeout';
    if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(String(failure.code))) return 'tls';
    if (['ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(String(failure.code)))
      return 'network';
    current = failure.cause;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message) ? 'network' : 'invalid_mcp';
}

/** Discover advertised MCP capabilities from the gateway's network namespace. */
export async function testUpstreamMcp(
  endpoint: string,
  timeoutMs = 8_000,
  credential?: UpstreamTestCredential,
): Promise<UpstreamTestResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let stage: UpstreamTestResult['stage'] = 'initialize';
  let httpStatus: number | null = null;
  let observedFailure: UpstreamTestResult['reason'] | undefined;
  let cleanup = false;
  const catalogs: Pick<UpstreamTestResult, 'tools' | 'resources' | 'resource_templates' | 'prompts'> = {
    tools: null,
    resources: null,
    resource_templates: null,
    prompts: null,
  };
  let catalogBytes = 0;
  const metadata = (entry: { name: string; title?: string; description?: string }) => ({
    name: entry.name,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  });
  const listAll = async <T>(
    request: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<T[]> => {
    const items: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const page = await request(cursor);
      catalogBytes += Buffer.byteLength(JSON.stringify(page.items));
      if (catalogBytes > 1024 * 1024) throw new ProbeError('response_too_large');
      items.push(...page.items);
      if (page.nextCursor === undefined) return items;
      if (cursors.has(page.nextCursor)) throw new ProbeError('invalid_mcp');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  };
  const client = new Client({ name: 'mcp-gateway-connection-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    ...(credential ? { requestInit: { headers: { [credential.header]: credential.value } } } : {}),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init) => {
      const signal = cleanup ? AbortSignal.timeout(1_000) : controller.signal;
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      });
      if (init?.method === 'POST' && !cleanup) {
        httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          const reason =
            response.status === 401
              ? 'auth_required'
              : response.status === 403
                ? 'access_denied'
                : response.status === 404
                  ? 'not_found'
                  : response.status === 405
                    ? 'method_not_allowed'
                    : response.status >= 300 && response.status < 400
                      ? 'redirect'
                      : 'http';
          throw new ProbeError(reason, response.status);
        }
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      let size = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              stream.close();
              return;
            }
            size += chunk.value.byteLength;
            if (size > 1024 * 1024) {
              observedFailure = 'response_too_large';
              stream.error(new ProbeError('response_too_large'));
              await reader.cancel();
              controller.abort();
              return;
            }
            stream.enqueue(chunk.value);
          } catch (error) {
            stream.error(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const result = (reason: UpstreamTestResult['reason']): UpstreamTestResult => {
    const server = client.getServerVersion();
    return {
      ok: reason === 'ok',
      reason,
      stage,
      duration_ms: Math.round(performance.now() - started),
      http_status: httpStatus,
      server: server ? { name: server.name.slice(0, 128), version: server.version.slice(0, 128) } : null,
      protocol_version: transport.protocolVersion?.slice(0, 64) ?? null,
      tools_count: catalogs.tools?.length ?? null,
      ...catalogs,
    };
  };
  try {
    const options = { timeout: timeoutMs, signal: controller.signal };
    await client.connect(transport, options);
    const capabilities = client.getServerCapabilities();
    const discover = async (kind: keyof typeof catalogs, load: () => Promise<void>) => {
      try {
        await load();
        return null;
      } catch (error) {
        return { kind, error };
      }
    };
    const discoveries = await Promise.all([
      capabilities?.tools &&
        discover('tools', async () => {
          catalogs.tools = await listAll(async (cursor) => {
            const page = await client.listTools({ cursor }, options);
            return { items: page.tools.map(metadata), nextCursor: page.nextCursor };
          });
        }),
      capabilities?.resources &&
        discover('resources', async () => {
          catalogs.resources = await listAll(async (cursor) => {
            const page = await client.listResources({ cursor }, options);
            return {
              items: page.resources.map((entry) => ({ ...metadata(entry), uri: entry.uri, mimeType: entry.mimeType })),
              nextCursor: page.nextCursor,
            };
          });
        }),
      capabilities?.resources &&
        discover('resource_templates', async () => {
          try {
            catalogs.resource_templates = await listAll(async (cursor) => {
              const page = await client.listResourceTemplates({ cursor }, options);
              return {
                items: page.resourceTemplates.map((entry) => ({
                  ...metadata(entry),
                  uriTemplate: entry.uriTemplate,
                  mimeType: entry.mimeType,
                })),
                nextCursor: page.nextCursor,
              };
            });
          } catch (error) {
            // Some resource servers provide only static resources.
            if (!(error instanceof McpError && error.code === ErrorCode.MethodNotFound)) throw error;
            catalogs.resource_templates = [];
          }
        }),
      capabilities?.prompts &&
        discover('prompts', async () => {
          catalogs.prompts = await listAll(async (cursor) => {
            const page = await client.listPrompts({ cursor }, options);
            return {
              items: page.prompts.map((entry) => ({
                ...metadata(entry),
                ...(entry.arguments
                  ? {
                      arguments: entry.arguments.map((argument) => ({
                        name: argument.name,
                        ...(argument.description === undefined ? {} : { description: argument.description }),
                        ...(argument.required === undefined ? {} : { required: argument.required }),
                      })),
                    }
                  : {}),
              })),
              nextCursor: page.nextCursor,
            };
          });
        }),
    ]);
    const failed = discoveries.find((entry) => entry && 'error' in entry);
    if (failed) {
      stage = failed.kind;
      throw failed.error;
    }
    stage = capabilities?.prompts
      ? 'prompts'
      : capabilities?.resources
        ? 'resources'
        : capabilities?.tools
          ? 'tools'
          : 'initialize';
    return result('ok');
  } catch (error) {
    if (error instanceof ProbeError && error.httpStatus !== undefined) httpStatus = error.httpStatus;
    const reason = observedFailure ?? (controller.signal.aborted ? 'timeout' : upstreamTestFailure(error));
    const discoveryFailure =
      stage === 'tools' ? 'tools_failed' : stage === 'prompts' ? 'prompts_failed' : 'resources_failed';
    return result(reason === 'invalid_mcp' && stage !== 'initialize' ? discoveryFailure : reason);
  } finally {
    clearTimeout(timer);
    cleanup = true;
    await transport.terminateSession().catch(() => undefined);
    controller.abort();
    await client.close().catch(() => undefined);
  }
}
