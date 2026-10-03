/** Streamable HTTP requires rejecting browser requests from untrusted origins. */
export function isAllowedMcpOrigin(
  origin: string | undefined,
  resourceBaseUrl: string,
  extraOrigins = process.env.MCP_ALLOWED_ORIGINS ?? '',
): boolean {
  if (origin === undefined) return true; // Non-browser MCP clients normally omit Origin.
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return false;
    const allowed = new Set([new URL(resourceBaseUrl).origin]);
    for (const entry of extraOrigins.split(',')) {
      const value = entry.trim();
      if (value) {
        if (new URL(value).origin !== value) return false;
        allowed.add(value);
      }
    }
    return allowed.has(origin);
  } catch {
    return false;
  }
}

export function mcpCorsHeaders(origin: string | undefined, resourceBaseUrl: string): Record<string, string> {
  if (!origin || !isAllowedMcpOrigin(origin, resourceBaseUrl)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers':
      'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'access-control-expose-headers': 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
    vary: 'Origin',
  };
}
