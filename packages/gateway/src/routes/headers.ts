const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);

function copyHeaders(headers: Record<string, unknown>, excluded: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  const connectionTokens = String(headers.connection ?? headers.Connection ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const token of connectionTokens) excluded.add(token);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || excluded.has(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

/** Only the Gateway may construct identity and forwarding headers for upstreams. */
export function filterRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const excluded = new Set([
    'host',
    'content-length',
    'authorization',
    'cookie',
    'set-cookie',
    'origin',
    'forwarded',
    'x-real-ip',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-forwarded-server',
  ]);
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-mcp-') || lower.startsWith('x-forwarded-')) excluded.add(lower);
  }
  return copyHeaders(headers, excluded);
}

/** Upstream cookies must not become cookies on the Gateway's public origin. */
export function filterResponseHeaders(headers: Record<string, unknown>): Record<string, string> {
  return copyHeaders(headers, new Set(['set-cookie']));
}
