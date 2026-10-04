import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UpstreamTestResult } from '@mcp/shared';

class ProbeError extends Error {
  constructor(readonly reason: UpstreamTestResult['reason']) {
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

/** Run a real MCP handshake and tools/list from the gateway's network namespace. */
export async function testUpstreamMcp(endpoint: string, timeoutMs = 8_000): Promise<UpstreamTestResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let stage: UpstreamTestResult['stage'] = 'initialize';
  let httpStatus: number | null = null;
  let observedFailure: UpstreamTestResult['reason'] | undefined;
  let cleanup = false;
  const client = new Client({ name: 'mcp-gateway-connection-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init) => {
      try {
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
            throw new ProbeError(reason);
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
      } catch (error) {
        if (!cleanup) observedFailure ??= upstreamTestFailure(error);
        throw error;
      }
    },
  });
  const result = (reason: UpstreamTestResult['reason'], tools: number | null = null): UpstreamTestResult => {
    const server = client.getServerVersion();
    return {
      ok: reason === 'ok',
      reason,
      stage,
      duration_ms: Math.round(performance.now() - started),
      http_status: httpStatus,
      server: server ? { name: server.name.slice(0, 128), version: server.version.slice(0, 128) } : null,
      protocol_version: transport.protocolVersion?.slice(0, 64) ?? null,
      tools_count: tools,
    };
  };
  try {
    const options = { timeout: timeoutMs, signal: controller.signal };
    await client.connect(transport, options);
    if (client.getServerCapabilities()?.tools) {
      stage = 'tools';
      const tools = await client.listTools({}, options);
      return result('ok', tools.tools.length);
    }
    return result('ok');
  } catch (error) {
    const reason = observedFailure ?? (controller.signal.aborted ? 'timeout' : upstreamTestFailure(error));
    return result(reason === 'invalid_mcp' && stage === 'tools' ? 'tools_failed' : reason);
  } finally {
    clearTimeout(timer);
    cleanup = true;
    await transport.terminateSession().catch(() => undefined);
    controller.abort();
    await client.close().catch(() => undefined);
  }
}
