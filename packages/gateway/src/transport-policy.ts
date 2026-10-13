/** Slow business tools must not inherit the short protocol-handshake deadline. */
export function upstreamRequestTimeout(method: string | undefined, protocolTimeoutMs: number): number {
  if (method !== 'tools/call') return protocolTimeoutMs;
  const configured = Number(process.env.UPSTREAM_TOOL_TIMEOUT_MS ?? 600_000);
  return Number.isSafeInteger(configured) && configured >= 1000 && configured <= 3_600_000 ? configured : 600_000;
}

/** Accept both Fastify's parsed objects and its raw JSON buffer parser. */
export function rpcMethod(body: unknown): string | undefined {
  try {
    const value: unknown = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
    return value && typeof value === 'object' && 'method' in value && typeof value.method === 'string'
      ? value.method
      : undefined;
  } catch {
    return undefined;
  }
}
